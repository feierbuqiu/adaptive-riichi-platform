# Practice bank contract

The practice bank is a private runtime directory. It contains a public-format
configuration file and a JSON Lines question source.

## `bank.config.json`

```json
{
  "id": "example-practice",
  "displayName": "Example Practice Bank",
  "sourceFile": "questions.enriched.jsonl",
  "expectedUsableQuestions": 3,
  "cohortPool": [1, 2]
}
```

- `id` is a stable ASCII identifier.
- `displayName` is user-facing.
- `sourceFile` must be a filename in the same directory.
- `expectedUsableQuestions` prevents accidental partial imports.
- `cohortPool` contains unique question numbers shown first, in shuffled order,
  during the first round.

## Question JSONL

Each line contains one object:

```json
{
  "id": 1,
  "annotation": {
    "scene": {},
    "dora_indicators": "1m",
    "hand": "123456789m123p1z",
    "draw": "1z",
    "melds": []
  },
  "answer": {
    "answer_action": "discard",
    "answer_tile": "1z",
    "public_practice_eligible": true,
    "is_disputed": false
  }
}
```

Tile values use MPSZ notation. Production banks and answer keys must remain in
private storage and be mounted read-only through `PRACTICE_BANK_ROOT`.
