# CLAUDE.md

Guidance for Claude, and any other AI agent, working in this repository. The README describes
the app, its measured results, its known limits and the layout of the code; read the parts that
bear on your task. The design plan is a separate Claude Doc kept by the owner, Lawrence Fan
(GitHub: SquawkBirdies); its link is in the project instructions.

## The app

- A mechanical-watch timegrapher for Safari on the iPhone (iOS 18.4 or later) that listens
  through the microphone. A folder of static files served by GitHub Pages from `main`: plain
  JavaScript modules, no build step, no runtime dependencies.
- The signal pipeline in `js/dsp/` uses only standard JavaScript and `performance.now()`, with no
  DOM, so the same code runs in the Node tests and in the app's background worker. Keep it that
  way. `js/ui/model.js`, `js/ui/positions.js`, `js/ui/position-icons.js`, `js/audio/live.js`,
  `js/audio/ring.js` and `js/store.js` stay free of the page too, so that the tests can run them.

## Commands

```
npm test                 # all tests, about fifteen minutes; Node 22 or later, nothing to install
npm run typecheck        # tsc over js/ with the strict settings in jsconfig.json
node --test tests/live.test.js                                      # one file
node --test --test-name-pattern="basket case" tests/irregular.test.js   # matching tests
node tools/run-stream.js tests/fixtures/eta-2836-2.wav 2 54         # real-time pipeline, printed
node tools/run-stream.js tests/fixtures/omega-3861-safari.wav 0 0 4096 0 0 36   # with a lift angle
node tools/run-analysis.js tests/fixtures/eta-2836-2.wav 2 54       # whole-recording analysis
python3 -m http.server 8000          # the app at http://localhost:8000, where the microphone works
```

Both `npm` commands must pass before a pull request.

## Code

- Every exported function, class and type has JSDoc type comments, and the type check stays
  clean.
- Two-space indentation, single quotes, semicolons. Match the code around you.
- Comments explain why, in full sentences. Prose and comments use British spelling (analyse,
  colour, licence); existing identifiers stay as they are.
- Text the user sees is plain language. Numbers are shown only while the pipeline is locked:
  a dash, never a stale value.

## Tests

- `node:test` files in `tests/`, helpers in `tests/helpers/`, recordings in `tests/fixtures/`.
  Each test's name is a sentence saying what must hold.
- Expected values come from the truth: simulated watches with known rate, beat error and beat
  times (`js/audio/simulator.js`), and the real recordings in `tests/fixtures/`. Don't loosen a
  tolerance to let a change pass without saying so in the pull request.
- The suite is slow because it runs the pipeline on minutes of audio. Never run the same pipeline
  computation twice: within a file, share a computed run between tests, as `clear()` in
  `tests/stream.test.js` does, and add assertions to an existing run of the same audio rather
  than streaming it again.
- Some tests also run the earlier behaviour through switches (`timing: { preferNear: false }` or
  `{ followScatter: false }`) to show why a change was made.
- The pipeline reads the sounds inside the beats (`js/dsp/soundstage.js`) only when it is given a
  lift angle, and spreads each reading's computing by the clock. A test that gives one also sets
  `sounds: { share: Infinity }`, which finishes every reading in the audio block it starts in, or
  gives the stage a clock of its own, so that the result does not depend on the computer.
- `tests/fixtures/` holds only recordings Lawrence made; the README describes each. Add one only
  when he asks, byte for byte as saved apart from any metadata, and check first that it holds
  nothing but the audio format and the samples.

## Changing the pipeline

- Measure the readings of the five watch recordings and the no-watch capture before and after.
  They must not move unless the change is meant to move them, and the pull request gives the
  numbers either way.
- Never smooth a watch's genuine irregularity, and never state a reading more precisely than its
  beats allow. The irregular-watch tests, and the basket case among them, guard this.
- Prefer finding out what is happening over averaging it away. When a change has a cost, such as
  delay, computing time or false alarms, measure it and say so.
- When behaviour or results change, update the README's results and limits, and the design plan
  if you can reach it.

## Checking in a browser

The model behind the screen has Node tests; the drawing and the page do not. Check them in
headless Chrome where it and Playwright are available. Chrome can play a WAV file in as the
microphone; the flags are in `docs/hosting.md`. Only Lawrence can test on the iPhone: give him
short steps and the result to expect, and say what was checked only on a computer.

## Git and pull requests

- Never commit to `main`. Each milestone or fix gets its own branch and one pull request, which
  Lawrence reviews and merges. Don't merge, force-push or delete branches.
- Commit as SquawkBirdies with the address 27929967+SquawkBirdies@users.noreply.github.com.
  Lawrence's personal email address must never appear in the repository, a commit or a pull
  request.
- If `gh pr create` fails, open the pull request through the REST API:
  `gh api repos/SquawkBirdies/watch-timegrapher-web-app/pulls --method POST --input pr.json`, with
  the title, head, base and body in `pr.json`.
- A pull request says what changed, which checks ran with their numbers, the trade-offs and
  limits, and what Lawrence should try on his phone.

## README

- Keep "What works today" and the lists of limits accurate, with numbers and the conditions they
  were measured under.
- Keep "Use of generative AI" accurate: who did what, and which models were used.
- Lines wrap at about 100 characters.
