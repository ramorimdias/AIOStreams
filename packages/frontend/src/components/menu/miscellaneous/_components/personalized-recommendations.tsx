import type { UserData } from '@aiostreams/core';
import { SimklConnect } from './simkl-connect';
import { Select } from '@aiostreams/ui/select';
import { Switch } from '@aiostreams/ui/switch';
import { TextInput } from '@aiostreams/ui/text-input';
import { useUserData } from '@/context/userData';
import { SettingsCard } from '../../../shared/settings-card';
import { useState } from 'react';

type Settings = NonNullable<UserData['personalizedRecommendations']>;

export function PersonalizedRecommendations() {
  const { uuid, userData, setUserData } = useUserData();
  const [variant, setVariant] = useState('');
  const settings = userData.personalizedRecommendations ?? {};
  const update = (patch: Partial<Settings>) =>
    setUserData((prev) => ({
      ...prev,
      personalizedRecommendations: {
        ...prev.personalizedRecommendations,
        ...patch,
      },
    }));
  return (
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
            label="Simkl account scope"
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
            label="Earliest release year"
            type="number"
            value={settings.fromYear?.toString() ?? ''}
            onValueChange={(value) =>
              update({ fromYear: value ? Number(value) : undefined })
            }
          />
          <TextInput
            label="Latest release year"
            type="number"
            value={settings.toYear?.toString() ?? ''}
            onValueChange={(value) =>
              update({ toYear: value ? Number(value) : undefined })
            }
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
          <TextInput
            label="Excluded movie TMDB genre IDs"
            defaultValue={settings.excludedMovieGenres?.join(',') ?? ''}
            onBlur={(event) =>
              update({
                excludedMovieGenres: event.target.value
                  .split(',')
                  .map((id) => id.trim())
                  .filter(Boolean),
              })
            }
          />
          <TextInput
            label="Excluded series TMDB genre IDs"
            defaultValue={settings.excludedSeriesGenres?.join(',') ?? ''}
            onBlur={(event) =>
              update({
                excludedSeriesGenres: event.target.value
                  .split(',')
                  .map((id) => id.trim())
                  .filter(Boolean),
              })
            }
          />
          <TextInput
            label="Excluded TMDB keyword IDs"
            defaultValue={settings.excludedKeywords?.join(',') ?? ''}
            onBlur={(event) =>
              update({
                excludedKeywords: event.target.value
                  .split(',')
                  .map((id) => id.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className="text-sm text-[--muted]">
            Use Addons → Catalogs to hide or reorder individual rows.
          </p>
        </>
      )}
    </SettingsCard>
  );
}
