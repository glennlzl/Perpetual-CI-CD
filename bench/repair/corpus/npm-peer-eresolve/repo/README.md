# dashboard

The operations dashboard as static markup: `renderDashboard()` renders every panel in `src/panels.js`, and
`renderPanel(panel)` one of them.

A panel has a `title`, its `series` (`{ name, values }`), `gridLines` (none by default) and a `legend` side: `left`,
`right` (the default), `top`, `bottom`, or `none`.

The charts come from Acme's chart kit, which is not published to a registry. `vendor/` holds the release tarballs we
have pulled, each with its README and CHANGELOG, and `package.json` names the versions in use.
