import { runSuite } from "../helpers";

export function run(): Promise<void> {
  return runSuite(__dirname, ["missing"]);
}
