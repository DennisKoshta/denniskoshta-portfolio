Three more BB(6) nonhalting proofs: a bouncer whose apparent chaotic edge follows an exact recurrence.

```text
1RB1LD_0RC1RC_1LA1RE_---1LE_1RF0RC_0RB0LF
1RB1LE_1LC1RD_0LA1LA_---1RE_1LF0LA_0LC0RF
1RB0RD_0RC0LB_0RD1RD_1LE1RA_1RC1LF_---1LA
```

These are three starts of one transition table, after renaming states and reflecting one machine. The head crosses five blocks of ones separated by short words. Every twelve trips, two separators move closer; their collision rebuilds the blocks. Two collision types then alternate forever.

At the boundaries of each double cycle, the relevant block lengths obey:

```text
(n,x) → (n + 12x + 808, x + 32)
```

Each start has a separately proved opening into this family. They reach it at steps 153,126,993; 153,013,640; and 163,638,058 respectively. The closed recurrence then proves all three never halt.

Rocq proof PR: https://github.com/ccz181078/busycoq/pull/27
Full write-ups: https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/chaotic-edge/writeups.zip
Space-time images (ZIP): https://raw.githubusercontent.com/DennisKoshta/busycoq/bbd8dec7ca70afd80523654b85ed142c3742e163/materials/chaotic-edge/images.zip

AI assistance: Claude (Anthropic) assisted with the original formal proofs, proof sketches, scripts and checks. GPT-6 Astra (OpenAI) assisted with independent audit and submission preparation.
