import { triage } from "./agents/triage.js";
import { investigator } from "./agents/investigator.js";
import { fixer } from "./agents/fixer.js";

export default {
  agents: [triage, investigator, fixer],
};
