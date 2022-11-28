require('dotenv').config({path: `${__dirname}/.env`});

const {isNull, isNullOrUndefined, isNumber: isPureNumber, isString, isEmpty} = require("@abhijithvijayan/ts-utils");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const fetch = require('node-fetch');
const hash = require('object-hash');
const express = require('express');
const { Deta } = require('deta');
const cors = require("cors");

const server = express();
const deta = Deta(process.env.DETA_PROJECT_KEY);
const db = deta.Base(process.env.DETA_DB_NAME);

const timezoneOffset = 0; // for UTC
const cacheTTL = 5 * 60 * 1000; // 5 minutes

function adjustForTimezone(date, offset = 0) {
    const timeOffsetInMS = offset * 60 * 60 * 1000;
    date.setTime(date.getTime() + timeOffsetInMS);

    return date;
}

function getTimeInSeconds(date = new Date()) {
    const today = adjustForTimezone(date, timezoneOffset);

    return today.getTime() / 1000;
}

// 'a,b,c' => ['a', 'b', 'c']
function extractFromString(str) {
    return str
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
}

const initPuppeteer = async () => {
    let browser = null;

    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
        console.debug({msg: "browser initialized"});
    } catch (err) {
        throw err instanceof Error ? err : new Error(err);
    }

   return browser;
};

// for parsing application/json bodies
server.use(express.json());
// @see: https://stackoverflow.com/a/14631683
server.set('trust proxy', true);
server.use(
    cors({
        origin: extractFromString(process.env.CORS_ORIGINS),
    })
);

function getCacheKey(obj) {
    const payload = {
        url: obj.url,
    };

    return hash(payload);
}

// Note: error handler middleware MUST have 4 parameters: error, req, res, next. Otherwise, handler won't fire.
const errorHandler = (err, req, res, next) => {
    console.error({err});

    let payload = {};
    if (req.method === 'POST') {
        payload = req.body;
    } else {
        payload = req.query;
    }

    // capture error in slack
    fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'post',
        body: JSON.stringify({
            "attachments": [
                {
                    "fallback": "Exception: Something went wrong!",
                    "author_name": `${req.method} ${req.originalUrl.split("?")[0]} - 500`,
                    "title": "Exception: Something went wrong!",
                    "title_link": "https://deta.sh",
                    "fields": [
                        {
                            "title": "Received",
                            "value": JSON.stringify(payload),
                            "short": false
                        }
                    ],
                    "text": `*Message*: ${err.message}`,
                    "footer": `_via <https://deta.sh|deta.sh>_`,
                    "footer_icon": "https://avatars.slack-edge.com/2022-10-27/4269372913767_b64924b6bd2772bc2b77_72.png",
                    "ts": adjustForTimezone(new Date(), timezoneOffset).getTime(),
                    "color": "#E03E2F"
                }
            ]
        }),
        headers: {'Content-Type': 'application/json'},
    }).catch(() => {
        //
    })

    res.sendStatus(500);
}

const sendResponse = (req, res, next) => {
    if (!isNullOrUndefined(req._cached)) {
        return res.status(200).json({
            status: "OK",
            data: req._cached
        })
    }

    next(new Error("Server Error"));
}

const cacheEntry = async (req, res, next) => {
    try {
        if (!isNullOrUndefined(req._entry)) {
            console.debug({msg: "caching response"});
            // update cache
            req._cached = await db.put(req._entry);
            console.debug({msg: "caching successful"});
        }

        next();
    } catch (err) {
        next(err);
    }
}

const getBrowser = async (req, res, next) => {
    try {
        if (isNullOrUndefined(req._cached)) {
            // if cache exist, no need to initialize browser
            req._browser = await initPuppeteer();
        }

        next();
    } catch (err) {
        next(err);
    }
}

const computeHash = (req, res, next) => {
    // get hash from query params
    req._hash = getCacheKey(req.query);
    console.debug({msg: "hash", hash: req._hash});

    next();
}

function isNumber(value) {
    // returns true if number or a number string
    return isPureNumber(value) || (isString(value) && !isEmpty(value) && isPureNumber(+value));
}

const getFromCache = async (req, res, next) => {
    try {
        // get entry from DB
        const entry = await db.get(req._hash);
        // compute the cache TTL from query
        const offsetMilliSeconds = isNumber(req.query.cacheTTL) ? Number(req.query.cacheTTL) : cacheTTL;

        if (!isNull(entry)) {
            // if cache entry falls into the cache TTL window, return that item
            const currentTimeInSeconds = getTimeInSeconds(new Date());
            const cacheTimestampInSeconds = getTimeInSeconds(new Date(entry.timestamp));
            const offsetInSeconds = offsetMilliSeconds / 1000;

            if (
                // the current time should be greater than the cached timestamp
                currentTimeInSeconds >= cacheTimestampInSeconds &&
                // but within the cache window
                currentTimeInSeconds < cacheTimestampInSeconds + offsetInSeconds
            ) {
                console.debug({msg: "cache exist", ttl: offsetMilliSeconds});
                req._cached = entry;
            } else {
                console.debug({msg: "cache expired", ttl: offsetMilliSeconds});
            }
        } else {
            console.debug({msg: "not in cache"});
        }

        next();
    } catch (err) {
        next(err)
    }
}

server.use((req, res, next) => {
    // disable cache control for /api routes
    // this removes the 304 status for requests
    if (/^\/api\//.test(req.originalUrl)) {
        res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    }

    return next();
});

// status check route
server.get('/ping', (req, res) => {
    return res.json('pong');
});

server.get('/api/v1/html', [
    computeHash,
    getFromCache,
    getBrowser,
    async (req, res, next) => {
        try {
            const url = req.query.url;

            if (isNullOrUndefined(req._cached) && !isNull(req._browser) && !isNull(url)) {
                let page = await req._browser.newPage();
                console.debug({msg: "loading page"});

                // wait till the network calls are completed
                // since this function has a timeout of 10seconds, give a max of 9seconds before timing out
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 9000 });
                console.debug({msg: "page loaded"});

                // get page html
                let bodyHTML = await page.evaluate(() =>  document.documentElement.outerHTML);
                console.debug({msg: "getting html"});

                // no need to wait for browser to close
                req._browser.close();

                // payload to store in DB
                req._entry = {
                    key: req._hash,
                    url,
                    html: bodyHTML,
                    timestamp: adjustForTimezone(new Date(), timezoneOffset) // in UTC
                };
            }

            next();
        } catch (err) {
            next(err)
        }
    },
    cacheEntry,
    sendResponse
]);

server.use(errorHandler);

module.exports = server;