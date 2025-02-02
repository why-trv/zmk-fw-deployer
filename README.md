# ZMK Firmware Deployer

A quick and dirty Node.js script to make deploying **ZMK** split keyboard firmware artifacts from GitHub Actions a tiny bit easier.

Looks for the latest build artifact in your ZMK config repo (`deploy` mode) or the newly built artifacts (`watch` mode), downloads, unzips and 'copies' the firmware to the **nice!nano** bootloader volume (`NICENANO`). The only thing you need to do is double-click the reset button on the halves of your keyboard when the script asks you to. 

**Important:** If a `NICENANO` volume is already mounted when running the script, it's assumed to be the **left** half of the keyboard.

## Installation

1. Run `npm install` to install the dependencies.
2. Copy `.env.example` to `.env` and fill in the values for your ZMK config repo.

## Usage

To install the latest firmware artifact from your repo, run:

```bash
npm run deploy
```

or, to watch for newly built firmware artifacts and (semi-)automatically deploy them, run:

```bash
npm run watch
```

### Say

On macOS, you can add the `--say` or `--say=<voice>` flag to notify you using the system `say` command when the script is waiting for you to double-click the reset button. The optional voice argument is the name of the voice to use, e.g. `Albert` or `Bells` (run `say -v '?'` to see all available voices).

```bash
npm run watch -- --say=Bubbles
```

## Disclaimer

Use at your own risk. This hasn't been tested much apart from cases where everything works as expected.
