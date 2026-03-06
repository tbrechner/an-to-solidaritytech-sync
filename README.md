# AN to SolidarityTech Sync

A script for synchronizing data between Action Network and Solidarity Tech.

## Overview

This repository, when used on a Cloudflare Worker, automates the process of syncing contact and campaign data from Action Network to Solidarity Tech for a specific letter-writing campaign (but can be modified for any project).

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare account
- Action Network API key
- Solidarity Tech API credentials

## Setup

1. Clone the repository

2. Install dependencies:
    ```bash
    npm install
    ```

3. Configure your environment variables using Wrangler secrets:
    ```bash
    wrangler secret put WEBHOOK_SECRET
    wrangler secret put SOLIDARITY_TECH_API_KEY
    ```

## Development

Run the worker locally:
```bash
wrangler dev
```

## Deployment

Deploy to Cloudflare Workers:
```bash
wrangler deploy
```

## Usage

Once deployed, the worker will automatically sync data (if you use an Action Network webhook).

## License

MIT
