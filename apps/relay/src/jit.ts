import { base64 } from "./crypto.ts";
import { HttpError } from "./types.ts";

// Pinned actions/runner Runner.cs writes this dictionary before LoadSettings().
// The public JIT REST endpoint does not accept a disableupdate option. Keep the
// maintained exporter intact using the same setting as config.sh --disableupdate.
export function preservePatchedRunner(encoded: string, expectedRunnerName: string): string {
  try {
    if (!encoded || encoded.length > 262144) throw new Error();
    const decode = (value: string): string => new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
    const files = JSON.parse(decode(encoded)) as Record<string, string>;
    if (!files || typeof files !== "object" || Array.isArray(files) || typeof files[".runner"] !== "string") throw new Error();
    if (Object.entries(files).some(([name, value]) => !/^\.[a-zA-Z0-9_-]+$/.test(name) || typeof value !== "string")) throw new Error();
    const settings = JSON.parse(decode(files[".runner"])) as Record<string, unknown>;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error();
    // GitHub's REST JIT payload uses PascalCase and may serialize settings as
    // strings (for example Ephemeral:"True"). Accept only an explicit true;
    // never coerce "False", 1, or another truthy value into an ephemeral runner.
    const properties = (name: string): unknown[] => Object.entries(settings).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
    const ephemeral = properties("ephemeral"), names = properties("agentname");
    const explicitTrue = (value: unknown): boolean => value === true || (typeof value === "string" && value.toLowerCase() === "true");
    if (!ephemeral.length || ephemeral.some(value => !explicitTrue(value)) || !names.length || names.some(value => value !== expectedRunnerName)) throw new Error();
    for (const key of Object.keys(settings)) if (["ephemeral", "disableupdate"].includes(key.toLowerCase())) delete settings[key];
    settings.ephemeral = true;
    settings.disableUpdate = true;
    files[".runner"] = base64(new TextEncoder().encode(JSON.stringify(settings)));
    return base64(new TextEncoder().encode(JSON.stringify(files)));
  } catch { throw new HttpError(502, "GitHub JIT configuration format is incompatible with the pinned runner; registration is held for reconciliation"); }
}
