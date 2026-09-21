# Signal Pilot Discord Connector

This unpacked Chrome extension lets a user choose authorised Discord channels from the Discord web app. It reads the visible channel list and, after an explicit selection, relays newly appearing message text from those channels to the local Signal Pilot server.

It does not inspect Discord credentials, session tokens, direct messages, or unselected channels.

## Install for local testing

1. Run Sacred Soul on `http://localhost:8788`.
2. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, then choose this `discord-channel-connector` folder.
3. In Signal Pilot, choose **Signal Sources → Connect Discord**. The dashboard detects the extension first.
4. If it is missing, Signal Pilot displays the extension-install screen. Complete the Chrome steps above, reload Signal Pilot, and choose **I installed it — check again**.
5. Discord opens in a new tab. Existing Discord users stay logged in; otherwise Discord handles its own sign-in.
6. The in-page **Signal Pilot** button opens automatically. Select one or more channels and save. Return to Signal Pilot to see the connected sources.

The pairing code is passed only in the Discord URL fragment, then removed by the extension after pairing. It is rotated once it has been used.

For a production release, we will package the extension, use a TLS API rather than localhost, add user accounts and source ownership, and prefer Discord's official bot/Gateway API wherever a server owner can authorize it.
