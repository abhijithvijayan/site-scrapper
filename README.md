# site-scrapper

A simple websitesite scrapper

## Docs

### Set up deta.sh

> <https://docs.deta.sh/docs/cli/install>

### Deploy to Deta

```shell
deta new --node site-scrapper
yarn install
yarn deploy
```

#### Note: For subsequent deployment run only

```shell
yarn deploy
```

### Create Slack Bot For Workspace

> <https://slack.com/intl/en-in/help/articles/115005265703-Create-a-bot-for-your-workspace>

### Sample Curl
```
curl --request GET \
  --url 'https://api.domain/api/v1/html?url=https://example.com&cacheTTL=1000' \
  --header 'content-type: application/json'
```
