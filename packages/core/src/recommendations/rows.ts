export const recommendationSource = 'aiostreams-recommendations';
export const recommendationRows = {
  top: 'Top Picks for You',
  'anime-top': 'Top Picks for You (Anime)',
  watched: 'Because You Watched',
  loved: 'Because You Loved',
  genres: 'Favorite Genre 1',
  'genres-2': 'Favorite Genre 2',
  'genres-3': 'Favorite Genre 3',
  themes: 'Favorite Theme 1',
  'themes-2': 'Favorite Theme 2',
  'themes-3': 'Favorite Theme 3',
  creators: 'From Your Favorite Creators',
  positive: 'Based on What You Loved/Liked',
};
export type RecommendationRow = keyof typeof recommendationRows;
export const recommendationRowIds = Object.keys(
  recommendationRows
) as RecommendationRow[];
export const genreRows = ['genres', 'genres-2', 'genres-3'] as const;
export const themeRows = ['themes', 'themes-2', 'themes-3'] as const;

export function recommendationSourceId(variant: string) {
  return variant ? recommendationSource + '-' + variant : recommendationSource;
}

export function isRecommendationCatalog(id: string) {
  return (
    id === recommendationSource ||
    id.startsWith(recommendationSource + '.') ||
    id.startsWith(recommendationSource + '-')
  );
}
