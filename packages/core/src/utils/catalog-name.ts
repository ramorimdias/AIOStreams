/** Recommendation headings belong to the upstream addon unless explicitly renamed. */
export function isRecommendationCatalog(id: string): boolean {
  return /(?:^|\.)recommendations\./.test(id);
}

export function catalogNameOverride(catalog: {
  id: string;
  name?: string;
  nameIsCustom?: boolean;
}): string | undefined {
  if (
    !catalog.nameIsCustom &&
    isRecommendationCatalog(catalog.id) &&
    /^Favorite (?:Theme|Genre) [123]$/i.test(catalog.name?.trim() ?? '')
  )
    return undefined;
  return catalog.name || undefined;
}
