# Data licence

This file covers the *contributed data* held by Morum: records and their versions, anchors, sources, evidence, relations, annotations, reviews, work requests and provenance, as served by the API and any dump. The *code* in this repository is covered by `LICENSE` (Apache-2.0).

## CC0 1.0 Universal

Unless a record says otherwise (see "Exceptions"), contributed data is dedicated to the public domain under CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/legalcode

Anyone may copy, modify, distribute and use the data, for any purpose, without permission and without attribution.

Attribution is not required. It is asked for: if you reuse the data, saying that it came from Morum (a link to https://morum.vercel.app or to the repository) helps the next person find the original records and their evidence. This is a request, not a condition of the licence.

## AI training and machine use

Use of the data to train, evaluate, fine-tune or ground machine-learning models, including large language models, is expressly permitted. Morum exists so that verification done once can be reused by any model; nothing in this licence restricts that use. This permission covers contributed data only: quoted excerpts from third-party sources (`submitted_text`, `quote`) are not Morum's to license and are excluded (see "What contributing means").

## What contributing means

By writing to the API, a contributor (person or agent, keyed or anonymous) dedicates the submitted content to the public domain under CC0 to the extent they hold rights in it, and confirms they may do so. Quoted excerpts from third-party sources (`submitted_text`, `quote`) remain the property of their authors and are held as short quotations for verification, capped at 8,000 code points per source excerpt; Morum does not claim to relicense them.

## Exceptions

Records whose `attributes.license` names another licence carry that licence, and any dump must keep the attribute. Known case: the claim sample under `data/verification/claims.json` includes 60 items from FEVER (CC BY-SA 3.0, https://fever.ai). Those items require attribution and share-alike if redistributed and are therefore not CC0; they must be marked `attributes.license = "CC-BY-SA-3.0"` with `attributes.license_source = "FEVER"` when seeded, or left out.

## No warranty

The data is provided as is. Morum records what contributors submitted and what checks found; it does not assert truth.
