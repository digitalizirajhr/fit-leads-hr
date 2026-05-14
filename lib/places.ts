// Google Places API (New) — Text Search wrapper.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
//
// Pricing note: with the FieldMask we use (basic + contact + atmosphere
// fields), each request is billed at the "Enterprise + Atmosphere" SKU
// (~$0.035/request). Google credits the first $200/month, which absorbs
// our worst case (17 cities × 6 terms × ≤3 pages = 306 calls ≈ $10.71).

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "nextPageToken",
].join(",");

// Hard cap on pagination follows. Google Places New caps at 60 results per
// query (3 pages × 20). We cap at 3 anyway as a belt-and-suspenders against
// any future change that might let pages grow unboundedly.
const MAX_PAGES = 3;

// Google requires a short delay before a nextPageToken becomes valid.
const PAGE_TOKEN_DELAY_MS = 2_000;

/** Shape of one place returned by the API, narrowed to the fields we ask for. */
export interface RawPlace {
  place_id: string;
  name: string;
  phone: string | null;
  current_website: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  google_rating: number | null;
  google_review_count: number | null;
}

interface PlacesApiResponse {
  places?: Array<{
    id: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    nationalPhoneNumber?: string;
    websiteUri?: string;
    rating?: number;
    userRatingCount?: number;
  }>;
  nextPageToken?: string;
}

function mapPlace(p: NonNullable<PlacesApiResponse["places"]>[number]): RawPlace {
  return {
    place_id: p.id,
    name: p.displayName?.text ?? "(unknown)",
    phone: p.nationalPhoneNumber ?? null,
    current_website: p.websiteUri ?? null,
    address: p.formattedAddress ?? null,
    latitude: p.location?.latitude ?? null,
    longitude: p.location?.longitude ?? null,
    google_rating: p.rating ?? null,
    google_review_count: p.userRatingCount ?? null,
  };
}

/**
 * Search Google Places for a (term, city) combo. Follows nextPageToken up to
 * MAX_PAGES times. Throws on HTTP error or schema mismatch.
 */
export async function searchPlaces({
  city,
  term,
  apiKey,
}: {
  city: string;
  term: string;
  apiKey: string;
}): Promise<RawPlace[]> {
  const results: RawPlace[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && pageToken) {
      await new Promise((r) => setTimeout(r, PAGE_TOKEN_DELAY_MS));
    }

    const body: Record<string, unknown> = {
      textQuery: `${term} ${city}`,
      languageCode: "hr",
      regionCode: "HR",
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      // Don't cache — every scrape should hit Google fresh.
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Places API ${res.status}: ${text || res.statusText}`);
    }

    const json = (await res.json()) as PlacesApiResponse;
    if (json.places?.length) results.push(...json.places.map(mapPlace));

    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

  return results;
}
