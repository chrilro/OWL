# OWL Suite

**O**rdinary **W**orking **L**inguist — a free, offline toolkit for documenting and analyzing under-described languages.

> **⚠ Preliminary / testing version.** OWL Suite is still under active development and is being shared here for testing and classroom use. Interfaces, file formats, and features may change. Please back up your project folder regularly, and send bug reports or feedback to **chris.linguist@gmail.com**.

---

## What it does

OWL Suite is five linguistics tools — **Writer**, **Glosser**, **Lexicon**, **Analyze**, and **Elicit** — built around one shared, plain-text corpus format, all delivered in a single HTML file. Pick a project folder once and every tool opens the same texts, translations, glosses, and lexicon with no import/export step between them.

### The tools

- **Writer** — write or import texts, add per-sentence and whole-text translations in any number of languages, find & replace across the corpus.
- **Glosser** — interlinear morpheme glossing with a suggester that learns from your own confirmed glosses and the curated lexicon (root/affix resolution, allomorphs, reduplication, infixes, and more).
- **Lexicon** — the project dictionary: morphemes, glosses, allomorphs, part of speech, semantic domains, and one-click promotion of glossed-but-uncurated morphemes from the corpus.
- **Analyze** — read-only frequency lists, KWIC concordance, multi-domain sentence search, collocation stats, and a lexicon-derived Phonology tab (segment inventory, IPA chart, minimal pairs).
- **Elicit** — vocabulary elicitation from Rapid Word Collection–style prompt lists, plus questionnaire-driven sentence elicitation (including TAM-style and narrative-sequenced prompts).

### Why one file

Every tool reads and writes the *same* plain `.txt` files and JSON sidecars sitting in your project folder — nothing is copied or converted between tools, so an edit in one is simply there in another. `owl_suite.html` is the whole suite compiled into a single page: choose your folder once, and it's shared automatically across all five tools.

---

## How to use

1. Download **both** `owl_suite.html` and `suite-core.js` — OWL Suite needs them in the *same* folder to run.
2. Open `owl_suite.html` in a modern desktop browser (**Chrome or Edge** — see [Browser support](#browser-support)).
3. Choose or create a folder for your project. Everything you save lives there as plain text and JSON — nothing is uploaded anywhere.
4. Use the tabs across the top to switch between Writer, Glosser, Lexicon, Analyze, and Elicit — they all share the one folder you picked.
5. Start in **Writer**: type or paste in a text, or import one.
6. Move to **Glosser** to add interlinear morpheme glosses — suggestions get smarter the more you've glossed.
7. Build up your **Lexicon** as you go, promoting glossed morphemes with one click.
8. Use **Analyze** to search, browse frequency and concordance data, and check phonology once you have enough curated forms.
9. Use **Elicit** to work through a vocabulary domain list or a sentence questionnaire.

Your project folder is portable — copy it anywhere, back it up, or move it between computers; OWL Suite will reconnect to it the next time you open the same folder.

### Browser support

OWL Suite is a purely client-side web app with no server and no install step, but it depends on the **File System Access API** for reading and writing your project folder directly. That currently means:

- ✅ **Chrome** and **Edge** (desktop)
- ❌ Safari and Firefox are not yet supported (no File System Access API)

---

## Files

| File | Description |
|---|---|
| `owl_suite.html` | The whole suite — Writer, Glosser, Lexicon, Analyze, and Elicit — in one file. |
| `suite-core.js` | Shared rules every tool depends on (segmentation, IDs, the lexicon format, autoglossing). Must sit next to `owl_suite.html`. |
| `README.md` | This file. |

---

## Citation

If you use OWL Suite in your research or language documentation work, please cite it as:

> Rogers, Chris. 2026. *OWL Suite (Ordinary Working Linguist)*. Software.

---

## License

© 2026 Chris Rogers

This software is a **preliminary, testing version** made available for **individual, non-commercial use only**, provided as-is with no warranty.

### Permitted use

- A student, researcher, or community member using the tool for personal or academic language documentation

### Not permitted without a license

- Commercial use of any kind
- Deployment or distribution for use by a group, organization, institution, or classroom

### Licensing

For institutional, classroom, or commercial licensing inquiries, contact:
**chris.linguist@gmail.com**

All rights reserved. Unauthorized commercial use or group deployment of this software is prohibited.

---

## About

OWL Suite is part of an ongoing effort to build practical, offline-first tools for language documentation. Feedback, bug reports, and questions are always welcome at **chris.linguist@gmail.com**.
