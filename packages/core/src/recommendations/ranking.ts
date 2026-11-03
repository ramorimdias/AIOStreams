/** Adapted from Watchly's profile and recommendation services. See WATCHLY-LICENSE. */
export type MediaType = 'movie' | 'series';
export type Feature =
  | 'genres'
  | 'keywords'
  | 'cast'
  | 'directors'
  | 'eras'
  | 'countries'
  | 'runtime'
  | 'languages';
export type HistoryItem = {
  imdb: string;
  rating?: number;
  watchedAt?: number;
  plays: number;
};
export type Title = {
  id: number;
  imdb?: string;
  adult?: boolean;
  name: string;
  description?: string;
  poster?: string;
  year?: number;
  releaseDate?: string;
  genres: string[];
  genreNames?: Record<string, string>;
  keywords: string[];
  keywordNames?: Record<string, string>;
  cast: string[];
  directors: string[];
  countries: string[];
  language?: string;
  runtime?: number;
  votes: number;
  rating: number;
  popularity: number;
};

const weights = {
  genres: 0.9,
  keywords: 0.7,
  cast: 0.9,
  directors: 0.9,
  eras: 0.6,
  countries: 0.3,
  runtime: 0.3,
  languages: 0.3,
};
const caps = {
  genres: 50,
  keywords: 40,
  cast: 30,
  directors: 30,
  eras: 25,
  countries: 20,
  runtime: 25,
  languages: 20,
};
const features = Object.keys(weights) as Feature[];
type Axis = Map<string, { score: number; count: number }>;
export type Profile = Record<Feature, Axis>;

export const discovery = {
  mainstream: { rating: 6.2, min: 1500 },
  balanced: { rating: 6.7, min: 250 },
  gems: { rating: 7.2, min: 150, max: 4000 },
  all: { rating: 5, min: 50 },
};
export type Style = keyof typeof discovery;

export function evidence(item: HistoryItem, now: number): number {
  // Watchly's Simkl converter collapses explicit ratings into loved and liked.
  const base =
    (item.rating ?? 0) >= 9 ? 2.5 : (item.rating ?? 0) >= 7 ? 1.5 : 1;
  const days =
    item.watchedAt === undefined
      ? undefined
      : Math.floor((now - item.watchedAt) / 86400000);
  return (
    base *
    (days === undefined
      ? 0.5
      : Math.max(0.1, Math.exp(-Math.max(0, days) / 30)))
  );
}

function vector(title: Title, type: MediaType): Record<Feature, string[]> {
  const runtime = title.runtime;
  return {
    genres: title.genres,
    keywords: title.keywords,
    cast: title.cast.slice(0, 5),
    directors: title.directors,
    countries: title.countries,
    eras: title.year
      ? [
          title.year < 1970
            ? 'pre-1970s'
            : String(Math.min(2020, Math.floor(title.year / 10) * 10)) + 's',
        ]
      : [],
    runtime: runtime
      ? [
          runtime < (type === 'movie' ? 120 : 30)
            ? 'short'
            : runtime <= (type === 'movie' ? 180 : 60)
              ? 'medium'
              : 'long',
        ]
      : [],
    languages: title.language ? [title.language] : [],
  };
}

export function buildProfile(
  items: { history: HistoryItem; title: Title }[],
  type: MediaType,
  now: number
): Profile {
  const profile = Object.fromEntries(
    features.map((axis) => [axis, new Map()])
  ) as Profile;
  for (const { history, title } of items) {
    const values = vector(title, type);
    const weight = evidence(history, now);
    for (const axis of features) {
      const keys =
        axis === 'genres' || axis === 'cast'
          ? values[axis].slice(0, 3)
          : values[axis];
      keys.forEach((key, index) => {
        const position =
          axis === 'genres'
            ? [1, 0.8, 0.5][index]
            : axis === 'cast'
              ? Math.max(0.2, 0.7 ** index)
              : 1;
        const entry = profile[axis].get(key) ?? { score: 0, count: 0 };
        entry.score += weight * weights[axis] * position;
        entry.count++;
        profile[axis].set(key, entry);
      });
    }
  }
  for (const axis of features) {
    for (const entry of profile[axis].values()) {
      const repeat =
        axis !== 'eras' && axis !== 'countries'
          ? 1 + Math.log(entry.count) * 0.1
          : 1;
      entry.score = Math.min(caps[axis], entry.score * repeat);
    }
  }
  return profile;
}

export function weightedRating(title: Title, prior: number): number {
  return (title.votes * title.rating + 150 * prior) / (title.votes + 150);
}

export function rank(candidates: Title[], profile: Profile, type: MediaType) {
  const maxima = features.map((axis) =>
    Math.max(1e-12, ...Array.from(profile[axis].values(), ({ score }) => score))
  );
  return candidates
    .map((title) => {
      const values = vector(title, type);
      // Watchly tracks runtime but its profile scorer ranks these six axes.
      const match = features.reduce((sum, axis, i) => {
        if (axis === 'runtime' || axis === 'languages' || !values[axis].length)
          return sum;
        const average =
          values[axis].reduce(
            (total, key) => total + (profile[axis].get(key)?.score ?? 0),
            0
          ) / values[axis].length;
        return sum + (average / maxima[i]) * weights[axis];
      }, 0);
      const quality = weightedRating(title, type === 'movie' ? 7.2 : 6.8);
      const boost =
        title.popularity > 500 && quality > 7.5
          ? 1.05
          : title.votes >= 100 && quality >= 7 && title.popularity <= 100
            ? 1.1
            : 1;
      return {
        title,
        score:
          (match * 0.7 + Math.min(1, Math.max(0, quality / 10)) * 0.3) * boost,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function diversify(titles: Title[], limit: number): Title[] {
  const genres = new Map<string, number>();
  const creators = new Map<string, number>();
  const result: Title[] = [];
  for (const title of titles) {
    if (result.length >= limit) break;
    const genre = title.genres[0];
    const people = new Set([...title.directors, ...title.cast.slice(0, 3)]);
    if (genre && (genres.get(genre) ?? 0) >= Math.max(1, Math.floor(limit / 2)))
      continue;
    if ([...people].some((id) => (creators.get(id) ?? 0) >= 3)) continue;
    result.push(title);
    if (genre) genres.set(genre, (genres.get(genre) ?? 0) + 1);
    for (const id of people) creators.set(id, (creators.get(id) ?? 0) + 1);
  }
  return result;
}
