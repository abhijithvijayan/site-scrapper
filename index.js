require('dotenv').config({path: `${__dirname}/.env`});

const {isNull, isNullOrUndefined} = require("@abhijithvijayan/ts-utils");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const hash = require('object-hash');
const express = require('express');
const { Deta } = require('deta');
const cors = require("cors");

const server = express();
const deta = Deta(process.env.DETA_PROJECT_KEY);
const db = deta.Base(process.env.DETA_DB_NAME);

function adjustForTimezone(date, offset = 0) {
    const timeOffsetInMS = offset * 60 * 60 * 1000;
    date.setTime(date.getTime() + timeOffsetInMS);

    return date;
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
        console.error({err});
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

const errorHandler = (err, req, res, next) => {
    console.error({err});

    res.sendStatus(500);
}

const sendResponse = (req, res) => {
    if (!isNullOrUndefined(req._cached)) {
        return res.status(200).json({
            status: "OK",
            data: req._cached
        })
    }

    throw new Error("Server Error");
}

const cacheEntry = async (req, res, next) => {
    if (!isNullOrUndefined(req._entry)) {
        console.debug({msg: "caching response"});
        // update cache
        req._cached = await db.put(req._entry);
        console.debug({msg: "caching successful"});
    }

    next();
}

const getBrowser = async (req, res, next) => {
    req._browser = await initPuppeteer();

    next();
}

server.get('/', [
    getBrowser,
    async (req, res, next) => {
        const url = req.query.url;

        // get hash from query params
        const hash = getCacheKey(req.query);
        console.debug({msg: "hash", hash});

        if (!isNull(req._browser) && !isNull(url)) {
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
                key: hash,
                url,
                html: bodyHTML,
                timestamp: adjustForTimezone(new Date()) // in UTC
            };
        }

        next();
    },
    cacheEntry,
    sendResponse
]);

server.use(errorHandler);

module.exports = server;