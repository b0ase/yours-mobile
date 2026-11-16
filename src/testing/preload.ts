/**
 * Loaded once before any test file (bunfig.toml [test] preload).
 *
 * framer-motion decides "am I in a browser?" once, when it is first imported (typeof window). `bun test` runs every
 * file in one process, so whichever file imported it first decided for all of them: a file that stubs `window`
 * (stubGlobals) and then imports a component made framer-motion take its browser path for the rest of the run, and
 * a later server render (payee.test.ts's SendConfirmation) failed with "SVGElement is not defined" / "window is not
 * defined", depending on file order. Importing it here, before any stub, fixes the answer to "no browser", which is
 * what every test file expects.
 */
import 'framer-motion';
