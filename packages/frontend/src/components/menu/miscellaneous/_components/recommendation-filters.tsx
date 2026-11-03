import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@aiostreams/ui/button';
import { Slider } from '@aiostreams/ui/slider';
import { TextInput } from '@aiostreams/ui/text-input';
import { useDebounce } from '@aiostreams/ui/hooks/debounce';
import { LuPlus, LuX } from 'react-icons/lu';
import { lookupRecommendationKeywords } from '@/lib/api';

// TMDB uses separate movie and TV genre lists.
const sharedGenres = {
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  9648: 'Mystery',
  37: 'Western',
};
export const movieGenres = {
  ...sharedGenres,
  28: 'Action',
  12: 'Adventure',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
};
export const seriesGenres = {
  ...sharedGenres,
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

export function ReleaseYearRange({
  fromYear,
  toYear,
  onChange,
}: {
  fromYear?: number;
  toYear?: number;
  onChange: (from?: number, to?: number) => void;
}) {
  const min = 1870;
  const max = Math.max(
    new Date().getFullYear() + 1,
    (toYear ?? 0) + 1,
    (fromYear ?? 0) + 1
  );
  return (
    <div className="space-y-1 md:col-span-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">Release years</span>
        <div className="flex items-center gap-3">
          <output className="font-mono text-sm" aria-live="polite">
            {fromYear ?? min} – {toYear ?? 'Now'}
          </output>
          <Button
            size="sm"
            intent="gray-subtle"
            disabled={fromYear === undefined && toYear === undefined}
            onClick={() => onChange()}
          >
            Reset
          </Button>
        </div>
      </div>
      <Slider
        aria-label="Release years"
        min={min}
        max={max}
        step={1}
        value={[fromYear ?? min, toYear ?? max]}
        onValueChange={([start, end]) =>
          onChange(
            start === min ? undefined : Math.min(start, max - 1),
            end === max ? undefined : end
          )
        }
      />
    </div>
  );
}

export function GenreExclusions({
  label,
  genres,
  value,
  onChange,
}: {
  label: string;
  genres: Record<string, string>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const options = Object.entries(genres).sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  for (const id of value) {
    if (!(id in genres)) options.push([id, 'Genre #' + id]);
  }
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(([id, name]) => {
          const excluded = value.includes(id);
          return (
            <Button
              key={id}
              type="button"
              rounded
              size="sm"
              aria-pressed={excluded}
              intent={excluded ? 'primary' : 'gray-subtle'}
              disabled={!excluded && value.length >= 30}
              onClick={() =>
                onChange(
                  excluded
                    ? value.filter((item) => item !== id)
                    : [...value, id]
                )
              }
            >
              {name}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function KeywordExclusions({
  value,
  onChange,
  apiKey,
  accessToken,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  apiKey?: string;
  accessToken?: string;
}) {
  const [input, setInput] = useState('');
  const query = useDebounce(input.trim(), 350);
  const search = useQuery({
    queryKey: [
      'recommendation-keyword-search',
      query,
      value,
      Boolean(apiKey || accessToken),
    ],
    queryFn: () =>
      lookupRecommendationKeywords(
        query.length >= 2 ? query : '',
        value,
        apiKey,
        accessToken
      ),
    enabled: query.length >= 2 || value.length > 0,
    staleTime: 300000,
    retry: false,
  });
  const options = new Map(
    (search.data ?? []).map(({ id, name }) => [String(id), name])
  );
  const matches = [...options].filter(([id]) => !value.includes(id));
  return (
    <div className="space-y-2">
      <TextInput
        label="Excluded keywords"
        placeholder="Search TMDB keywords"
        value={input}
        onValueChange={setInput}
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Excluded keywords">
          {value.map((id) => {
            const name = options.get(id) ?? 'Keyword #' + id;
            return (
              <Button
                key={id}
                type="button"
                rounded
                size="sm"
                intent="primary"
                rightIcon={<LuX />}
                aria-label={'Remove ' + name}
                onClick={() => onChange(value.filter((item) => item !== id))}
              >
                {name}
              </Button>
            );
          })}
        </div>
      )}
      {search.isError && (
        <p className="text-sm text-[--muted]">
          Keyword lookup unavailable. Check your TMDB settings.
        </p>
      )}
      {query.length >= 2 &&
        !search.isError &&
        (search.isFetching ? (
          <p className="text-sm text-[--muted]">Searching…</p>
        ) : matches.length ? (
          <div className="flex flex-wrap gap-2">
            {matches.map(([id, name]) => (
              <Button
                key={id}
                type="button"
                rounded
                size="sm"
                intent="gray-subtle"
                leftIcon={<LuPlus />}
                disabled={value.length >= 30}
                onClick={() => onChange([...value, id])}
              >
                {name}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[--muted]">
            No additional keywords found.
          </p>
        ))}
    </div>
  );
}
