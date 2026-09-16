# Previously Deleted Files

Immich remembers the files you permanently delete, so that the same file does not quietly come back the next time a device backs up or a folder is uploaded again. When a file is permanently deleted (the trash is emptied, an item expires from the trash or an item is deleted without going through the trash), its checksum is stored for the owner. An upload of a file with that checksum is then handled according to the owner's preference instead of being stored like a new file.

Moving a file to the trash does not remember it: only a permanent deletion does. External library assets and the motion parts of live photos are never remembered.

## Modes

The preference can be changed in the user settings under "Previously deleted files", both on the web and in the mobile app.

| Mode                | Behaviour                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move to the trash   | The default. The file is stored and moved to the trash right away, where it can be reviewed. It is deleted for good with the usual trash retention unless it is restored.                                                                                        |
| Do not upload it    | The file is not stored. The upload is answered like a duplicate, and the bulk upload check the CLI and the web uploader use before uploading reports the file as a duplicate too, so it is not sent at all.                                                      |
| Add it to the album | The file is stored like any other file and added to an album named "Previously deleted", which is created when needed. Removing the album or renaming it does no harm: Immich keeps track of the album by its id and creates a new one when the old one is gone. |

## Keeping a file

Sometimes a file was deleted by mistake, and the re-upload is wanted. Restoring the file from the trash (in the trash mode) or removing it from the "Previously deleted" album (in the album mode) keeps the file and forgets its checksum, so it is treated like any other file from then on.

In the "Do not upload it" mode there is nothing to keep, because nothing is stored. The list of remembered files can be cleared at any time with the "Forget all remembered files" button in the settings, after which every file can be uploaded again.

## Notifications

After a batch of uploads Immich sends one in-app notification that sums up how many previously deleted files were moved to the trash, skipped or added to the album. Uploads are collected for a few minutes before the notification is created, so a large backup produces a single message rather than one per file. Opening the notification on the web leads to the trash or to the "Previously deleted" album.

:::note Mobile backup
The mobile app decides what still needs to be backed up by comparing the checksums of the local files with the assets on the server. In the "Do not upload it" mode a skipped file has no asset on the server, so the app keeps seeing it as not backed up and offers it again on the next backup run, where it is skipped once more. The trash and album modes do not have this limitation.
:::

## API

Two endpoints expose the remembered files of the current user:

- `GET /api/users/me/deleted-checksums/statistics` returns how many files are remembered.
- `DELETE /api/users/me/deleted-checksums` forgets all of them.

The preference itself is part of the user preferences (`deletedReimport.mode`), and the response also carries the id of the "Previously deleted" album once it exists.
