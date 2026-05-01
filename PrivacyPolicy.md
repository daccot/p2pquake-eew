# Privacy Policy

## Overview

This extension does not collect, store, or transmit any personal information.

## Data Usage

The extension uses the following data locally:

- User settings (notification preferences, thresholds, location)
- Notification history (stored locally)

All data is stored using Chrome's storage API and remains on the user's device.

## External Communication

The extension connects to:

- P2PQuake WebSocket API  
  wss://api.p2pquake.net/v2/ws

This is used solely for receiving earthquake data.

No user data is sent externally.

## Permissions Justification

- storage: save user settings and history
- tabs: display notifications on open pages
- activeTab: optionally limit notifications to active tab
- host_permissions: connect to P2Pquake API and inject UI

## Third Parties

No third-party analytics, tracking, or advertising services are used.

## Contact

For any inquiries, please contact via GitHub Issues.
