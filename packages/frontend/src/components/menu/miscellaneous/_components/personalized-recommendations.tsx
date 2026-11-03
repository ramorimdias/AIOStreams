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
    <div className="space-y-4">
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
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {(['movie', 'series'] as const).map((type) => {
                const source = recommendationSourceId(variant);
                const Icon = type === 'movie' ? LuFilm : LuTv;
                return (
                  <section
                    key={type}
                    className="space-y-3 rounded-xl border border-[--border] p-4"
                  >
                    <h4 className="flex items-center gap-2 font-medium">
                      <Icon aria-hidden="true" />
                      {type === 'movie' ? 'Movies' : 'Series'}
                    </h4>
                    {recommendationRowIds.map((row) => {
                      const id = source + '.' + row;
                      const enabled =
                        userData.catalogModifications?.find(
                          (item) => item.id === id && item.type === type
                        )?.enabled ?? row !== 'anime-top';
                      return (
                        <Switch
                          key={row}
                          label={recommendationRows[row]}
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
                      );
                    })}
                  </section>
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
              <ReleaseYearRange
                fromYear={settings.fromYear}
                toYear={settings.toYear}
                onChange={(fromYear, toYear) => update({ fromYear, toYear })}
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
              <div className="md:col-span-2">
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
