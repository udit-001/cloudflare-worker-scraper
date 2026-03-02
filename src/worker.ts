import {
  generateErrorJSONResponse,
  generateJSONResponse,
} from './json-response'
import { linkType } from './link-type'
import Scraper from './scraper'
import { TidyURL } from 'tidy-url'
import { scraperRules } from './scraper-rules'

addEventListener('fetch', (event: FetchEvent) => {
  event.respondWith(handleRequest(event.request))
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

const toStringValue = (value: ScrapeResponse | undefined): string => {
  return typeof value === 'string' ? value : ''
}

const parseJsonLd = (value: ScrapeResponse | undefined): JSONValue | '' => {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    return JSON.parse(value)
  } catch {
    return ''
  }
}

const isYouTubeUrl = (url: string): boolean => {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtu.be'
    )
  } catch {
    return false
  }
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

const getYouTubeEmbedUrl = (url: string): string => {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.toLowerCase()
    let videoId = ''

    if (hostname === 'youtu.be') {
      videoId = parsedUrl.pathname.replace(/^\/+/, '').split('/')[0] || ''
    } else if (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname.endsWith('.youtube.com')
    ) {
      videoId =
        parsedUrl.searchParams.get('v') ||
        parsedUrl.pathname.replace(/^\/(shorts|embed)\//, '').split('/')[0] ||
        ''
    }

    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}`
    }
  } catch {}

  return ''
}

const getYouTubeOEmbed = async (url: string): Promise<YouTubeOEmbed | null> => {
  try {
    const oEmbedURL = new URL('https://www.youtube.com/oembed')
    oEmbedURL.searchParams.set('url', url)
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

async function handleRequest(request: Request) {
  const searchParams = new URL(request.url).searchParams
  const scraper = new Scraper()
  let response: Record<string, ScrapeResponse>
  let youtubePlayerDetails: Record<string, unknown> | null = null
  let youtubeOEmbed: YouTubeOEmbed | null = null
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

    await scraper.fetch(url)

    if (isYouTubeUrl(scraper.response.url)) {
      youtubePlayerDetails = await scraper.getYouTubePlayerDetails()
      youtubeOEmbed = await getYouTubeOEmbed(scraper.response.url)
    }
  } catch (error) {
    return generateErrorJSONResponse(error, url)
  }

  try {
    // Get metadata using the rules defined in `src/scraper-rules.ts`
    response = await scraper.getMetadata(scraperRules)

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
        if (typeof youtubeOEmbed.title === 'string' && youtubeOEmbed.title.trim()) {
          response.title = youtubeOEmbed.title.trim()
        }

        if (
          typeof youtubeOEmbed.author_name === 'string' &&
          youtubeOEmbed.author_name.trim()
        ) {
          response.author = youtubeOEmbed.author_name.trim()
        }

        if (
          typeof youtubeOEmbed.thumbnail_url === 'string' &&
          youtubeOEmbed.thumbnail_url.trim()
        ) {
          response.image = youtubeOEmbed.thumbnail_url.trim()
        }

        const embedUrl = getYouTubeEmbedUrl(toStringValue(response.url))
        if (embedUrl) {
          response.video = embedUrl
        }
      }

      const fullDescription =
        youtubePlayerDetails &&
        typeof youtubePlayerDetails.shortDescription === 'string'
          ? youtubePlayerDetails.shortDescription.trim()
          : ''

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

    // Parse JSON-LD if present, otherwise build a YouTube fallback.
    response.jsonld = parseJsonLd(response?.jsonld)

    if (!response.jsonld && isYouTubeUrl(toStringValue(response.url))) {
      response.jsonld = buildYouTubeJsonLdFallback(response)
    }
  } catch (error) {
    return generateErrorJSONResponse(error, url)
  }

  return generateJSONResponse(response)
}
