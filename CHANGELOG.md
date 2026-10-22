# Changelog

## 0.2.5

Distinguish interrupted turns from successful answers, including provider capacity
failures recorded as Paseo system messages and structured terminal errors.
Label the preceding process **Interrupted**, keep the error and any existing
answer visible, and preserve native controls for background commands.
Continuation requests stay separate from the interrupted turn.

## 0.2.4

Keep the native fold control in the initially loaded history page when opening
or switching long chats. Preserve desktop placement and native inline expansion.
Account for context compaction completing in its original position.

Retire an obsolete running tool placeholder when a later event records its
outcome. Keep the terminal result, including errors, visible and preserve live
commands when tool identities are ambiguous across viewed chats.

## 0.2.3

Fold completed work even when a preview server or another background command is
still marked running. Live commands retain their native status and controls;
active turns, pending permissions and unfinished work remain visible.

## 0.2.2

Remove the Paseo version restriction so daemon and app updates do not block
plugin loading. Package checks enforce the unrestricted manifest.

## 0.2.1

Document the configured GitHub Actions trusted publisher and the token-free
release procedure. Runtime behavior is unchanged.

## 0.2.0

First public release. Completed turns fold into one expandable row while final
answers stay visible. Includes context compaction, a Process composer control,
desktop viewport preservation, and a persistent native process block with Markdown,
tool details, copying and pagination.
