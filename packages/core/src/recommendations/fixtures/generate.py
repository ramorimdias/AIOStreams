"""Run against the pinned Watchly checkout to regenerate the ranking fixture.

Usage: python generate.py /path/to/Watchly > watchly.json
Only Watchly's pure scoring and profile methods are loaded. All inputs are synthetic.
"""
import ast
import collections
import datetime
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

root = Path(sys.argv[1])
env = {
    "math": math,
    "datetime": type("Clock", (), {"now": staticmethod(lambda _: datetime.datetime(2025, 1, 31, tzinfo=datetime.timezone.utc))}),
    "timezone": datetime.timezone,
    "DEFAULT_MINIMUM_RATING_FOR_THEME_BASED_MOVIE": 7.2,
    "DEFAULT_MINIMUM_RATING_FOR_THEME_BASED_TV": 6.8,
}


def load(path, names=None, methods=None):
    tree = ast.parse((root / "app" / path).read_text(encoding="utf-8"))
    if names:
        tree.body = [node for node in tree.body if getattr(node, "name", None) in names]
    else:
        tree.body = [node for node in tree.body if isinstance(node, ast.AnnAssign)]
    if methods:
        for node in tree.body:
            node.bases = []
            node.body = [method for method in node.body if getattr(method, "name", None) in methods]
    source = "from __future__ import annotations\n" + ast.unparse(tree)
    exec(compile(source, path, "exec"), env)


load("services/profile/constants.py")
load("services/profile/evidence.py", {"EvidenceCalculator"})
load("services/profile/builder.py", {"ProfileBuilder"}, {
    "_accumulate_features", "_apply_frequency_multipliers", "_apply_caps",
})
load("models/profile.py", {"TasteProfile"}, {"normalize_for_ranking"})
load("services/profile/scorer.py", {"ProfileScorer"})
load("services/recommendation/scoring.py", {"RecommendationScoring"})
env["DISCOVERY_SETTINGS"] = {"balanced": {"vote_average.gte": 6.7, "vote_count.gte": 250}}
env["DEFAULT_YEAR_MIN"] = 1900
env["get_current_year"] = lambda: 2025
env["defaultdict"] = collections.defaultdict
load("services/recommendation/filtering.py", {"filter_items_by_settings", "filter_by_genres", "filter_watched_by_imdb"})
load("services/recommendation/filtering.py", {"RecommendationFiltering"}, {"get_quality_thresholds"})
load("services/recommendation/diversity.py", {"apply_diversity_caps"})

history = [
    {"imdb": "tt1", "rating": 9, "watchedAt": 1738281600000, "plays": 1},
    {"imdb": "tt2", "rating": 7, "watchedAt": 1735689600000, "plays": 1},
]
titles = [
    dict(id=1, name="Alpha", genres=["28", "18"], keywords=["7"], year=2019,
         cast=["1", "2"], directors=["5"], countries=["US"], runtime=110, rating=8, votes=600, popularity=70),
    dict(id=2, name="Beta", genres=["18"], keywords=["7", "8"], year=1999,
         cast=["1"], directors=["6"], countries=["JP"], runtime=150, rating=7.3, votes=300, popularity=40),
]
profile = env["TasteProfile"]()
axes = {
    "genres": "genre_scores", "keywords": "keyword_scores", "eras": "era_scores",
    "countries": "country_scores", "cast": "cast_scores", "directors": "director_scores",
    "runtime": "runtime_bucket_scores",
}
for attr in [*axes.values(), "director_frequency", "cast_frequency"]:
    setattr(profile, attr, {})
frequencies = collections.defaultdict(lambda: collections.defaultdict(int))
builder = env["ProfileBuilder"]()
evidence = []
for item, title in zip(history, titles):
    interaction = SimpleNamespace(
        completion_rate=1,
        item=SimpleNamespace(
            is_loved=item["rating"] >= 9, is_liked=item["rating"] >= 7,
            state=SimpleNamespace(
                duration=6000, timeWatched=6000,
                lastWatched=datetime.datetime.fromtimestamp(item["watchedAt"] / 1000, datetime.timezone.utc),
            ),
        ),
    )
    weight = env["EvidenceCalculator"].calculate_evidence_weight(interaction)
    evidence.append(weight)
    builder._accumulate_features(profile, {
        "genres": title["genres"],
        "keywords": title["keywords"],
        "era": f'{title["year"] // 10 * 10}s',
        "countries": title["countries"],
        "cast": [{"id": actor, "weight": max(.2, .7 ** position)} for position, actor in enumerate(title["cast"])],
        "crew": [{"id": person, "job": "Director"} for person in title["directors"]],
        "runtime_bucket": "short" if title["runtime"] < 120 else "medium",
    }, weight, frequencies)

builder._apply_frequency_multipliers(profile, frequencies)
builder._apply_caps(profile)
candidates = [
    {**titles[0], "id": 101, "name": "Match", "imdb": "tt101"},
    {**titles[1], "id": 102, "name": "Partial match", "imdb": "tt102"},
    {**titles[0], "id": 103, "name": "Watched", "imdb": "tt1"},
    {**titles[0], "id": 104, "name": "Low confidence", "imdb": "tt104", "votes": 25},
]
scores = []
raw_candidates = []
for title in candidates:
    raw = {
        "id": title["id"], "_external_ids": {"imdb_id": title["imdb"]},
        "genre_ids": title["genres"], "keyword_ids": title["keywords"],
        "release_date": str(title["year"]), "production_countries": title["countries"],
        "credits": {
            "cast": [{"id": actor} for actor in title["cast"]],
            "crew": [{"id": person, "job": "Director"} for person in title["directors"]],
        },
        "vote_average": title["rating"], "vote_count": title["votes"], "popularity": title["popularity"],
    }
    raw_candidates.append(raw)
    scores.append(env["RecommendationScoring"].calculate_final_score(raw, profile, env["ProfileScorer"], "movie"))

settings = SimpleNamespace(popularity="balanced", year_min=1900, year_max=2025)
watched = {item["imdb"] for item in history}
eligible = env["filter_items_by_settings"](raw_candidates, settings)
filtered = env["filter_watched_by_imdb"](eligible, watched)
excluded = env["filter_by_genres"](filtered, set(), ["28"])
score_by_id = dict(zip([item["id"] for item in raw_candidates], scores))
ranked = sorted(((score_by_id[item["id"]], item) for item in filtered), key=lambda pair: -pair[0])
catalog = env["apply_diversity_caps"](ranked, 24, "movie", settings)

print(json.dumps({
    "now": 1738281600000, "history": history, "titles": titles, "evidence": evidence,
    "profile": {key: getattr(profile, attr) for key, attr in axes.items()},
    "candidates": candidates, "scores": scores,
    "eligible": [item["id"] for item in filtered],
    "genre_exclusion": [item["id"] for item in excluded],
    "catalog": [item["id"] for item in catalog],
    "order": [candidate["id"] for _, candidate in sorted(zip(scores, candidates), key=lambda pair: -pair[0])],
}, indent=2))
