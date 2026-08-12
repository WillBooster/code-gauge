# Real-world OSS fixture corpus

Verbatim single files from famous open-source projects, pinned to release tags, used by the E2E
tests to measure every supported metric on real-world code and to compare the TypeScript and native
Rust backends on it. Each file keeps its original license header; the table below records the exact
origin.

| File | Project | Tag | Path in repository | License |
| --- | --- | --- | --- | --- |
| `express-4.18.2-response.js` | [expressjs/express](https://github.com/expressjs/express) | `4.18.2` | `lib/response.js` | MIT |
| `mattermost-5.39.0-login_controller.jsx` | [mattermost/mattermost-webapp](https://github.com/mattermost/mattermost-webapp) | `v5.39.0` | `components/login/login_controller/login_controller.jsx` | Apache-2.0 |
| `vscode-1.85.0-uri.ts` | [microsoft/vscode](https://github.com/microsoft/vscode) | `1.85.0` | `src/vs/base/common/uri.ts` | MIT |
| `nextjs-14.0.4-image-component.tsx` | [vercel/next.js](https://github.com/vercel/next.js) | `v14.0.4` | `packages/next/src/client/image-component.tsx` | MIT |
| `requests-2.31.0-sessions.py` | [psf/requests](https://github.com/psf/requests) | `v2.31.0` | `requests/sessions.py` | Apache-2.0 |
| `gin-1.9.1-gin.go` | [gin-gonic/gin](https://github.com/gin-gonic/gin) | `v1.9.1` | `gin.go` | MIT |
| `ripgrep-14.1.0-gitignore.rs` | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) | `14.1.0` | `crates/ignore/src/gitignore.rs` | MIT OR Unlicense |
| `guava-33.0.0-Joiner.java` | [google/guava](https://github.com/google/guava) | `v33.0.0` | `guava/src/com/google/common/base/Joiner.java` | Apache-2.0 |
| `rails-7.1.2-methods.rb` | [rails/rails](https://github.com/rails/rails) | `v7.1.2` | `activesupport/lib/active_support/inflector/methods.rb` | MIT |
| `redis-7.2.3-intset.c` | [redis/redis](https://github.com/redis/redis) | `7.2.3` | `src/intset.c` | BSD-3-Clause |
| `bitcoin-25.0-bech32.cpp` | [bitcoin/bitcoin](https://github.com/bitcoin/bitcoin) | `v25.0` | `src/bech32.cpp` | MIT |

The files are test fixtures only; they are not compiled into or distributed with the published
package (`files` in `package.json` covers `dist/` only).
