import type { UserData } from '@aiostreams/core';
import { SimklConnect } from './simkl-connect';
import { Select } from '@aiostreams/ui/select';
import { Switch } from '@aiostreams/ui/switch';
import { TextInput } from '@aiostreams/ui/text-input';
import {
  GenreExclusions,
  KeywordExclusions,
  ReleaseYearRange,
  movieGenres,
  seriesGenres,
} from './recommendation-filters';
import { useUserData } from '@/context/userData';
import { SettingsCard } from '../../../shared/settings-card';
import { useState } from 'react';
import { LuFilm, LuTv } from 'react-icons/lu';
import {
  recommendationRows,
  recommendationRowIds,
  recommendationSourceId,
} from '../../../../../../core/src/recommendations/rows';

type Settings = NonNullable<UserData['personalizedRecommendations']>;

export function PersonalizedRecommendations() {
  const { uuid, userData, setUserData } = useUserData();
  const [variant, setVariant] = useState('');
  const source = recommendationSourceId(variant);
  const settings = userData.personalizedRecommendations ?? {};
  const scopeName =
    userData.variants?.find(({ id }) => id === variant)?.name ||
    variant ||
    'Base configuration';
  const update = (patch: Partial<Settings>) =>
    setUserData((prev) => ({
      ...prev,
      personalizedRecommendations: {
        ...prev.personalizedRecommendations,
        ...patch,
      },
    }));
  return (
    <div className="max-w-5xl space-y-4">
      <SettingsCard
        id="personalized-recommendations"
        title="Personalized Recommendations"
        description="Use your Simkl watch history to generate movie and series catalogs. Requires a TMDB credential from this instance or your Metadata Services settings."
      >
        <Switch
          label="Enable personalized recommendations"
          value={!!settings.enabled}
          onValueChange={(enabled) => update({ enabled })}
        />
        {settings.enabled && (
          <>
            <Select
              label="Simkl account and catalog scope"
              value={variant || '__base'}
              onValueChange={(value) =>
                setVariant(value === '__base' ? '' : value)
              }
              options={[
                { value: '__base', label: 'Base configuration' },
                ...(userData.variants ?? []).map(({ id, name }) => ({
                  value: id,
                  label: name ?? id,
                })),
              ]}
            />
            <SimklConnect key={`${uuid}:${variant}`} variant={variant} />
          </>
        )}
      </SettingsCard>
      {settings.enabled && (
        <>
          <SettingsCard
            title="Recommendation Catalogs"
            description={
              <>
                Editing <strong>{scopeName}</strong>. Choose which rows this
                scope shows, then save your configuration.
              </>
            }
          >
            <div className="divide-y divide-[--border] overflow-hidden rounded-lg border border-[--border]">
              <div className="grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-2 bg-gray-500/10 px-3 py-2 text-sm font-medium sm:grid-cols-[minmax(0,1fr)_6rem_6rem]">
                <span>Catalog</span>
                <span className="flex items-center justify-center gap-1">
                  <LuFilm aria-hidden="true" className="hidden sm:block" />
                  Movies
                </span>
                <span className="flex items-center justify-center gap-1">
                  <LuTv aria-hidden="true" className="hidden sm:block" />
                  Series
                </span>
              </div>
              {recommendationRowIds.map((row) => {
                const id = source + '.' + row;
                return (
                  <div
                    key={row}
                    className="grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-2 px-3 py-2 text-sm hover:bg-gray-500/5 sm:grid-cols-[minmax(0,1fr)_6rem_6rem]"
                  >
                    <span>{recommendationRows[row]}</span>
                    {(['movie', 'series'] as const).map((type) => {
                      const enabled =
                        userData.catalogModifications?.find(
                          (item) => item.id === id && item.type === type
                        )?.enabled ?? row !== 'anime-top';
                      return (
                        <div key={type} className="flex justify-center">
                          <Switch
                            aria-label={`${recommendationRows[row]} (${type === 'movie' ? 'Movies' : 'Series'})`}
                            value={enabled}
                            onValueChange={(value) =>
                              setUserData((prev) => {
                                const items = prev.catalogModifications ?? [];
                                const exists = items.some(
                                  (item) => item.id === id && item.type === type
                                );
                                return {
                                  ...prev,
                                  catalogModifications: exists
                                    ? items.map((item) =>
                                        item.id === id && item.type === type
                                          ? { ...item, enabled: value }
                                          : item
                                      )
                                    : [...items, { id, type, enabled: value }],
                                };
                              })
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </SettingsCard>
          <SettingsCard
            title="Discovery Preferences"
            description="Adjust the types of recommendations AIOStreams generates."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Select
                label="Discovery style"
                value={settings.style ?? 'balanced'}
                onValueChange={(style) =>
                  update({ style: style as Settings['style'] })
                }
                options={[
                  { value: 'mainstream', label: 'Mainstream' },
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'gems', label: 'Hidden Gems' },
                  { value: 'all', label: 'All' },
                ]}
              />
              <TextInput
                label="Refresh interval in hours"
                type="number"
                value={settings.refreshHours?.toString() ?? ''}
                placeholder="6"
                onValueChange={(value) =>
                  update({ refreshHours: value ? Number(value) : undefined })
                }
              />
              <ReleaseYearRange
                fromYear={settings.fromYear}
                toYear={settings.toYear}
                onChange={(fromYear, toYear) => update({ fromYear, toYear })}
              />
            </div>
          </SettingsCard>
          <SettingsCard
            title="Exclusions"
            description="Filter genres and keywords out of your recommendations."
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <GenreExclusions
                label="Exclude movie genres"
                genres={movieGenres}
                value={settings.excludedMovieGenres ?? []}
                onChange={(excludedMovieGenres) =>
                  update({ excludedMovieGenres })
                }
              />
              <GenreExclusions
                label="Exclude series genres"
                genres={seriesGenres}
                value={settings.excludedSeriesGenres ?? []}
                onChange={(excludedSeriesGenres) =>
                  update({ excludedSeriesGenres })
                }
              />
              <div className="lg:col-span-2">
                <KeywordExclusions
                  value={settings.excludedKeywords ?? []}
                  onChange={(excludedKeywords) => update({ excludedKeywords })}
                  apiKey={userData.tmdbApiKey}
                  accessToken={userData.tmdbAccessToken}
                />
              </div>
            </div>
          </SettingsCard>
        </>
      )}
    </div>
  );
}
