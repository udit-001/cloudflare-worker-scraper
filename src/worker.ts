import {
  generateErrorJSONResponse,
  generateJSONResponse,
} from './json-response'
import { linkType } from './link-type'
import Scraper from './scraper'
import { TidyURL } from 'tidy-url'
import { scraperRules } from './scraper-rules'

addEventListener('fetch', (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request, event))
})

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue }

interface JSONObject {
  [k: string]: JSONValue
}

export type ScrapeResponse = string | string[] | JSONObject
type YouTubeOEmbed = {
  title?: string
  author_name?: string
  thumbnail_url?: string
  html?: string
}
type FxTwitterPhoto = {
  url?: string
  width?: number
  height?: number
  type?: string
}

type FxTwitterVideo = {
  url?: string
  thumbnail_url?: string
  width?: number
  height?: number
  duration?: number
  format?: string
  type?: string
}

type FxTwitterExternalMedia = {
  url?: string
  width?: number
  height?: number
  duration?: number
  type?: string
}

type FxTwitterAuthor = {
  name?: string
  screen_name?: string
  avatar_url?: string
  banner_url?: string
}

type FxTwitterTweet = {
  url?: string
  text?: string
  author?: FxTwitterAuthor
  media?: {
    photos?: FxTwitterPhoto[]
    videos?: FxTwitterVideo[]
    external?: FxTwitterExternalMedia
  }
}

type FxTwitterStatusResponse = {
  code?: number
  message?: string
  tweet?: FxTwitterTweet
}

const CACHE_TTL_SECONDS = 3600
const STALE_WHILE_REVALIDATE_SECONDS = 86400

const toStringValue = (value: ScrapeResponse | undefined): string => {
  return typeof value === 'string' ? value : ''
}

const parseJsonLd = (value: ScrapeResponse | undefined): JSONObject | '' => {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JSONObject
    }
    return ''
  } catch {
    return ''
  }
}

const getYouTubeSchemaDescription = (jsonld: JSONValue | ''): string => {
  if (!jsonld || typeof jsonld !== 'object') return ''

  const findVideoDescription = (node: JSONValue): string => {
    if (!node || typeof node !== 'object') return ''

    if (Array.isArray(node)) {
      for (const item of node) {
        const description = findVideoDescription(item)
        if (description) return description
      }
      return ''
    }

    const typeValue = node['@type']
    const isVideoObject =
      typeof typeValue === 'string'
        ? typeValue === 'VideoObject'
        : Array.isArray(typeValue) &&
          typeValue.some((entry) => entry === 'VideoObject')

    if (isVideoObject && typeof node.description === 'string') {
      const description = node.description.trim()
      if (description) return description
    }

    for (const value of Object.values(node)) {
      const description = findVideoDescription(value)
      if (description) return description
    }

    return ''
  }

  return findVideoDescription(jsonld)
}

const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

const isYouTubeHost = (hostname: string): boolean => {
  return (
    hostname === 'youtu.be' ||
    hostname === 'youtube.com' ||
    hostname === 'www.youtube.com' ||
    hostname.endsWith('.youtube.com')
  )
}

const isYouTubeUrl = (url: string): boolean => {
  return isYouTubeHost(getHostname(url))
}

const isTwitterUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname === 'x.com' ||
      hostname === 'www.x.com' ||
      hostname.endsWith('.x.com') ||
      hostname === 'twitter.com' ||
      hostname === 'www.twitter.com' ||
      hostname.endsWith('.twitter.com')
    )
  } catch {
    return false
  }
}

const isInstagramUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname === 'instagram.com' ||
      hostname === 'www.instagram.com' ||
      hostname.endsWith('.instagram.com')
    )
  } catch {
    return false
  }
}

const toVxInstagramUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    if (
      hostname === 'instagram.com' ||
      hostname === 'www.instagram.com' ||
      hostname.endsWith('.instagram.com')
    ) {
      parsed.hostname = 'vxinstagram.com'
      return parsed.toString()
    }
  } catch {
    // Return original URL when parsing fails.
  }
  return url
}

const buildYouTubeJsonLdFallback = (
  response: Record<string, ScrapeResponse>
): JSONObject => {
  const jsonld: JSONObject = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: toStringValue(response.title),
    description: toStringValue(response.description),
    thumbnailUrl: toStringValue(response.image),
    uploadDate: toStringValue(response.date),
    embedUrl: toStringValue(response.video),
    url: toStringValue(response.url),
    keywords: toStringValue(response.keywords),
  }

  const author = toStringValue(response.author)
  if (author) {
    jsonld.author = {
      '@type': 'Person',
      name: author,
    }
  }

  return jsonld
}

const getYouTubeVideoId = (url: string): string => {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.toLowerCase()

    if (!isYouTubeHost(hostname)) return ''

    if (hostname === 'youtu.be') {
      return parsedUrl.pathname.replace(/^\/+/, '').split('/')[0] || ''
    }

    const vParam = parsedUrl.searchParams.get('v')
    if (vParam) return vParam

    const path = parsedUrl.pathname
    if (path.startsWith('/shorts/')) {
      return path.replace('/shorts/', '').split('/')[0] || ''
    }
    if (path.startsWith('/embed/')) {
      return path.replace('/embed/', '').split('/')[0] || ''
    }
  } catch {}

  return ''
}

const getYouTubeEmbedUrl = (url: string): string => {
  const videoId = getYouTubeVideoId(url)
  return videoId ? `https://www.youtube.com/embed/${videoId}` : ''
}

const normalizeYouTubeOEmbedUrl = (url: string): string => {
  const videoId = getYouTubeVideoId(url)
  if (!videoId) return url
  return `https://www.youtube.com/watch?v=${videoId}`
}

const getYouTubeOEmbed = async (url: string): Promise<YouTubeOEmbed | null> => {
  try {
    const oEmbedURL = new URL('https://www.youtube.com/oembed')
    oEmbedURL.searchParams.set('url', normalizeYouTubeOEmbedUrl(url))
    oEmbedURL.searchParams.set('format', 'json')

    const response = await fetch(oEmbedURL.toString(), {
      headers: {
        accept: 'application/json',
      },
    })
    if (!response.ok) return null

    const parsed = (await response.json()) as YouTubeOEmbed
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

const normalizeTwitterStatusUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase().includes('x.com')) {
      parsed.hostname = 'twitter.com'
    }
    return parsed.toString()
  } catch {
    return url
  }
}

const getTwitterStatusId = (url: string): string => {
  try {
    const parsed = new URL(normalizeTwitterStatusUrl(url))
    const parts = parsed.pathname.split('/').filter(Boolean)
    const statusIndex = parts.findIndex((part) => part === 'status')
    if (statusIndex === -1) return ''
    return parts[statusIndex + 1] || ''
  } catch {
    return ''
  }
}

const getFxTwitterStatus = async (
  url: string
): Promise<FxTwitterStatusResponse | null> => {
  const statusId = getTwitterStatusId(url)
  if (!statusId) return null

  const candidates = [url, normalizeTwitterStatusUrl(url)]

  for (const candidate of candidates) {
    try {
      const parsedCandidate = new URL(candidate)
      const pathParts = parsedCandidate.pathname.split('/').filter(Boolean)
      const screenName = pathParts[0] || 'i'
      const apiUrl = new URL(
        `https://api.fxtwitter.com/${encodeURIComponent(screenName)}/status/${encodeURIComponent(statusId)}`
      )

      const response = await fetch(apiUrl.toString(), {
        headers: {
          accept: 'application/json',
        },
      })
      if (!response.ok) continue

      const parsed = (await response.json()) as FxTwitterStatusResponse
      if (!parsed || typeof parsed !== 'object') continue
      if (parsed.code && parsed.code !== 200) continue
      if (!parsed.tweet || typeof parsed.tweet !== 'object') continue
      return parsed
    } catch {
      // continue to next candidate
    }
  }

  return null
}

async function handleRequest(request: Request, event?: FetchEvent) {
  const searchParams = new URL(request.url).searchParams
  const shouldBypassCache =
    searchParams.get('cache') === '0' || searchParams.get('refresh') === '1'
  const cacheUrl = new URL(request.url)
  cacheUrl.searchParams.delete('cache')
  cacheUrl.searchParams.delete('refresh')
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' })

  if (request.method === 'GET' && !shouldBypassCache) {
    const cached = await caches.default.match(cacheKey)
    if (cached) {
      const cachedResponse = new Response(cached.body, cached)
      cachedResponse.headers.set('x-worker-cache', 'HIT')
      return cachedResponse
    }
  }

  const scraper = new Scraper()
  let response: Record<string, ScrapeResponse>
  let youtubePlayerDetails: Record<string, unknown> | null = null
  let youtubeOEmbed: YouTubeOEmbed | null = null
  let fxTwitterStatus: FxTwitterStatusResponse | null = null
  let url = searchParams.get('url')
  const cleanUrl = searchParams.get('cleanUrl')

  if (!url) {
    return generateErrorJSONResponse(
      'Please provide a `url` query parameter, e.g. ?url=https://example.com'
    )
  }

  if (url && !url.match(/^[a-zA-Z]+:\/\//)) {
    url = 'https://' + url
  }

  try {
    const requestedUrl = new URL(url)

    // If the url is a reddit url, use old.reddit.com because it has much
    // more information when scraping
    if (url.includes('reddit.com')) {
      requestedUrl.hostname = 'old.reddit.com'
      url = requestedUrl.toString()
    }

    // Use vxinstagram for instagram URLs to get stable, bot-friendly OpenGraph data.
    if (isInstagramUrl(url)) {
      url = toVxInstagramUrl(url)
    }

    await scraper.fetch(url)

    if (isYouTubeUrl(scraper.response.url)) {
      youtubePlayerDetails = await scraper.getYouTubePlayerDetails()
      youtubeOEmbed = await getYouTubeOEmbed(scraper.response.url)
    }

    if (isTwitterUrl(scraper.response.url)) {
      fxTwitterStatus = await getFxTwitterStatus(scraper.response.url)
    }
  } catch (error) {
    return generateErrorJSONResponse(error, url)
  }

  try {
    // Get metadata using the rules defined in `src/scraper-rules.ts`
    response = await scraper.getMetadata(scraperRules)
    const parsedJsonLd = parseJsonLd(response?.jsonld)

    const unshortenedUrl = scraper.response.url

    // Add cleaned url
    if (cleanUrl) {
      const cleanedUrl = TidyURL.clean(unshortenedUrl || url)
      response.cleaned_url = cleanedUrl.url
    }

    // Add unshortened url
    response.url = unshortenedUrl

    // Add url type
    response.urlType = linkType(url, false)

    if (isYouTubeUrl(toStringValue(response.url))) {
      if (youtubeOEmbed) {
        if (
          !toStringValue(response.title) &&
          typeof youtubeOEmbed.title === 'string' &&
          youtubeOEmbed.title.trim()
        ) {
          response.title = youtubeOEmbed.title.trim()
        }

        if (
          !toStringValue(response.author) &&
          typeof youtubeOEmbed.author_name === 'string' &&
          youtubeOEmbed.author_name.trim()
        ) {
          response.author = youtubeOEmbed.author_name.trim()
        }

        if (
          !toStringValue(response.image) &&
          typeof youtubeOEmbed.thumbnail_url === 'string' &&
          youtubeOEmbed.thumbnail_url.trim()
        ) {
          response.image = youtubeOEmbed.thumbnail_url.trim()
        }

        const embedUrl = getYouTubeEmbedUrl(toStringValue(response.url))
        if (embedUrl && !toStringValue(response.video)) {
          response.video = embedUrl
        }
      }

      const schemaDescription = getYouTubeSchemaDescription(parsedJsonLd)
      const shortDescription =
        youtubePlayerDetails &&
        typeof youtubePlayerDetails.shortDescription === 'string'
          ? youtubePlayerDetails.shortDescription.trim()
          : ''
      const metadataDescription = toStringValue(response.description).trim()
      const fullDescription =
        schemaDescription || shortDescription || metadataDescription

      const channelName =
        youtubePlayerDetails && typeof youtubePlayerDetails.author === 'string'
          ? youtubePlayerDetails.author.trim()
          : ''

      if (fullDescription) {
        response.description = fullDescription
      }

      if (channelName && !toStringValue(response.author)) {
        response.author = channelName
      }
    }

    if (isTwitterUrl(toStringValue(response.url)) && fxTwitterStatus?.tweet) {
      const tweet = fxTwitterStatus.tweet
      const tweetAuthor = tweet.author
      const tweetText = typeof tweet.text === 'string' ? tweet.text.trim() : ''
      const tweetUrl = typeof tweet.url === 'string' ? tweet.url.trim() : ''
      const photo = Array.isArray(tweet.media?.photos)
        ? tweet.media?.photos.find(
            (item) => typeof item?.url === 'string' && item.url.trim()
          )
        : undefined
      const video = Array.isArray(tweet.media?.videos)
        ? tweet.media?.videos.find(
            (item) => typeof item?.url === 'string' && item.url.trim()
          )
        : undefined
      const external = tweet.media?.external

      if (typeof tweetAuthor?.name === 'string' && tweetAuthor.name.trim()) {
        response.author = tweetAuthor.name.trim()
      }

      if (tweetUrl) {
        response.url = tweetUrl
      }

      if (tweetText) {
        response.description = tweetText
      }

      if (!toStringValue(response.title) && tweetText) {
        response.title = tweetText.slice(0, 100)
      }

      if (!toStringValue(response.image)) {
        if (photo?.url) {
          response.image = photo.url.trim()
        } else if (video?.thumbnail_url) {
          response.image = video.thumbnail_url.trim()
        } else if (tweetAuthor?.avatar_url) {
          response.image = tweetAuthor.avatar_url.trim()
        }
      }

      if (!toStringValue(response.video)) {
        if (video?.url) {
          response.video = video.url.trim()
        } else if (typeof external?.url === 'string' && external.url.trim()) {
          response.video = external.url.trim()
        }
      }
    }

    // Parse JSON-LD if present, otherwise build a YouTube fallback.
    response.jsonld = parsedJsonLd

    if (!response.jsonld && isYouTubeUrl(toStringValue(response.url))) {
      response.jsonld = buildYouTubeJsonLdFallback(response)
    }
  } catch (error) {
    return generateErrorJSONResponse(error, url)
  }

  const finalResponse = generateJSONResponse(response)
  finalResponse.headers.set(
    'Cache-Control',
    `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`
  )
  finalResponse.headers.set(
    'CDN-Cache-Control',
    `public, s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`
  )
  finalResponse.headers.set('x-worker-cache', shouldBypassCache ? 'BYPASS' : 'MISS')

  if (request.method === 'GET' && !shouldBypassCache && event) {
    event.waitUntil(caches.default.put(cacheKey, finalResponse.clone()))
  }

  return finalResponse
}
