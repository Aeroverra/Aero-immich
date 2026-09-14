# Private Mode

Private mode hides a set of assets from every view until you unlock it with your PIN code. Unlike the locked folder, private assets stay in your albums, your timeline, search, the map and memories. They are simply not returned by the server while the mode is off.

## How it works

- Any asset can be marked private. Marking is only possible while private mode is on.
- Private mode is a per-session flag. You turn it on with your PIN code from the lock button in the navigation bar, and it turns off when you press the button again, when the session is idle for longer than the configured timeout, or when the mobile app goes to the background.
- While the mode is off, private assets are excluded from the timeline, albums, search, the map, memories, people counts, duplicates, stacks, folders, downloads and statistics. Requests for a private asset by id are rejected the same way requests for a locked asset are.
- While the mode is on, private assets appear everywhere like any other asset and carry a small lock badge on their thumbnail. A dedicated **Private** page lists only private assets.

## Albums

An album becomes private as soon as it contains a private asset, and stops being private when the last private asset is removed. Adding an asset to a private album marks that asset private, which also covers uploads into a private album. Adding assets to a private album requires private mode.

While the mode is off, a private album still shows up but without its private assets. Its item count and cover reflect only what is visible.

## Sharing

- **Partners** never see your private assets, in the same way they never see archived assets.
- **Shared albums** show private assets to another user only while that user has private mode on in their own session. Sharing a private album asks for a confirmation first.
- **Shared links** always include the private assets they cover, because a link has no session and no PIN. Creating a link that would expose private assets asks for a confirmation first.

## Settings

The idle timeout is configured under **Account Settings** as *Private mode timeout* and defaults to 30 minutes. Resetting your PIN code turns private mode off on every session.

## API keys

An API key has no session, so it cannot unlock private mode with a PIN code. By default an API key therefore never sees private assets or private albums, even with the `all` permission.

To let a key work with private assets, grant it the `privateMode.access` permission (**Account Settings > API Keys**, option *Private mode access*). A key with this permission behaves like a session with private mode on: it can read, change, mark and unmark private assets and private albums. It still needs the regular permissions for each action, for example `asset.read` or `asset.update`. `privateMode.access` is never included in `all` or in *Select all*, so it has to be granted on its own.

## Relation to the locked folder

Private mode and the locked folder are independent. An asset can be both locked and private. Unlocking the locked folder does not turn private mode on, and turning private mode on does not unlock the locked folder.
