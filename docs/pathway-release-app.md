# Pathway stable release App

Stable finalization uses `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` to mint a token, commit updated package versions, and push to `main`. Keep this separate from the fleet management App: the release job needs repository contents access, not runner administration. Using the dedicated App also preserves the existing follow-up CI behavior after its push.

Prepare the private **Pathway Release** App through GitHub's normal browser registration:

```sh
node scripts/setup-release-app.mjs
```

Open the printed loopback URL, normally `http://127.0.0.1:63156/`, and press **Pathway Release**. Set `PATHWAY_RELEASE_SETUP_PORT` to another local port if needed. Register under **SpiritDevs**, then install with **Only select repositories → pathway**. The manifest requests **Contents: write** and required **Metadata: read** only. Its webhook is explicitly inactive and it subscribes to no events. No OAuth login is needed for this API-only App.

The one-use state-checked callback saves `.fleet/pathway-release-app.json` with mode `600`, in the ignored `.fleet` directory with mode `700`. It stores only the private key and relevant App metadata; an absent webhook/client secret is valid. It refuses to overwrite existing credentials. Do not paste this key into the fleet relay or use the fleet App key for release finalization.

After installation, verify scope without changing repository secrets:

```sh
node scripts/install-release-secrets.mjs --check
```

The installer verifies the App identity and permissions using its signed JWT, requires exactly one organization installation, and checks that its selected repository set is exactly `SpiritDevs/pathway`. It creates a temporary installation token with read-only contents permission to inspect that selection and revokes the token afterward. It rejects the fleet App and any extra permissions/repositories.

Then, while stable finalization is inactive, install the credentials:

```sh
node scripts/install-release-secrets.mjs
```

The existing `gh` login must administer Pathway repository secrets. The script passes both values through stdin to `gh secret set`; it never places credentials in command arguments or prints them. It writes **repository Actions secrets**, which override same-named organization secrets. It verifies the two secret names exist afterward; GitHub never reveals the stored values. The two writes are not atomic: a partial failure reports which name changed and requires rerunning before stable finalization resumes.

Do not add a `GITHUB_TOKEN` fallback. This setup does not change branch protection or rulesets, which must independently allow the release App's version-bump push under the repository's chosen policy. Validate an actual stable finalization before claiming release coverage; setup alone does not publish a release or prove the push succeeds.

References: [GitHub manifest fields and flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [App identity and installation APIs](https://docs.github.com/en/rest/apps/apps), [installation token and repository APIs](https://docs.github.com/en/rest/apps/installations), and [GitHub CLI secret installation](https://cli.github.com/manual/gh_secret_set).
