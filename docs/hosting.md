# Hosting

The app is a folder of static files with no build step. It must be served over HTTPS, because
browsers allow the microphone only on secure pages. Opening `index.html` straight from the
Files app (a `file://` address) does not work.

GitHub Pages serves a public repository over HTTPS for free. The project's own site is at:

```
https://OWNER.github.io/watch-timegrapher-web-app/
```

where `OWNER` is the GitHub username that owns the repository.

## Setting up the project's site

These steps are done once. All of them work in Safari on an iPhone except where noted.

### 1. Create the repository

1. Sign in at github.com and choose **New repository** from the **+** menu.
2. Name it `watch-timegrapher-web-app` and make it **Public**. GitHub Pages is free only for
   public repositories.
3. Turn on the option to add a README. This creates the `main` branch. Leave the `.gitignore`
   and licence options at none: the project has its own.
4. Create the repository.

### 2. Add the files

Either of these works.

- **Let Claude push them.** Connect GitHub in claude.ai under Settings, then Connectors, and
  give the Claude GitHub app access to this repository. Claude then pushes the files to a
  branch and opens a pull request for you to merge.
- **Upload them yourself.** This needs a computer, because the iPhone's file picker cannot
  upload folders. Unzip the project, open the repository on github.com, choose **Add file**,
  then **Upload files**, and drag in everything inside the `watch-timegrapher-web-app` folder.
  Web uploads are limited to 100 files at a time and 25 MB per file; the project fits both.
  The hidden file `.gitignore` is optional and can be left out; `_config.yml` is needed (below).

### 3. Turn on GitHub Pages

1. In the repository, open **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Set the branch to `main` and the folder to `/ (root)`, then **Save**.
4. After a minute or two the page shows the site's address.

GitHub builds the site with Jekyll, its own site builder, so that `version.json` carries the
commit each deploy was built from; all three pages show it in their fine print, linked to the
commit, and the audio diagnostic puts it in its report. Jekyll publishes every other file as it is.
`_config.yml` leaves out the Markdown files and the folders the app does not load, so that none of
them is made into a page or read as a template. A build that fails, which the repository's Actions tab
shows, leaves the site as it was. Served any other way, as from a local server, the pages show no
version. Until 28 November 2026 a `.nojekyll` file switched Jekyll off.

### 4. Check it on the iPhone

Open the site's address in Safari, followed by `check.html`, for example
`https://YOUR-USERNAME.github.io/watch-timegrapher-web-app/check.html`. The browser check lists
five checks, and all five should say **Yes**:

| Check | What it shows |
| --- | --- |
| Secure connection | The page arrived over HTTPS |
| Microphone access offered | Safari can ask for the microphone (the page does not ask) |
| Audio worklets | Live audio can be received without gaps |
| Screen wake lock | The screen can be kept on during a measurement |
| Signal pipeline loads | The measurement code downloaded and started |

If the address shows a 404 page, wait a few minutes and reload, then check that Settings, Pages
shows the site as live from `main` and `/ (root)`.

## Updates

Every change merged into `main` republishes the site, usually within two minutes. GitHub Pages
lets browsers keep each file for 10 minutes, so for that long a page can show the old version, or
load old and new files together, which may not work; reloading does not help. Wait 10 minutes after
the deploy's run in the repository's Actions tab turns green, or open the site in a new Private tab.
The version in each page's fine print says which one has loaded.

## Hosting your own copy

1. Open the repository on github.com and choose **Fork**.
2. In your fork, follow step 3 above.
3. Your copy is at `https://YOUR-USERNAME.github.io/watch-timegrapher-web-app/`.

Any other static host that serves HTTPS works too, such as Netlify, Cloudflare Pages or your
own web server. Serve the folder as it is.

## Testing on a computer

From the repository folder, run:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`. Browsers treat `localhost` as secure, so the microphone works
there. An iPhone that opens the computer's address over Wi-Fi, such as
`http://192.168.1.20:8000`, is not on a secure page and cannot use the microphone; use GitHub
Pages for the phone.

Chrome can play a recording into the app in place of the microphone, which is how the
microphone path was tested on a computer:

```
google-chrome --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --use-file-for-fake-audio-capture=/path/to/recording.wav http://localhost:8000
```

The first flag allows the microphone without asking. A 16-bit WAV file works. Chrome plays it in
a loop and may deliver it at another sample rate: 44.1 kHz when this was tested. A few seconds of
digital silence inserted into the file make an interruption.

The simulated microphone is not a steady source for long. In headless Chrome on a two-core
computer, on 26 November 2026, every run lost its lock for about 4 s somewhere between 30 and
110 s in, most of them near 35 s, with the app as it was before that day's change as well as
after. To watch the app for longer than half a minute, choose the recording under Your file
instead: it is replayed sample for sample at real speed, through the same worker.
