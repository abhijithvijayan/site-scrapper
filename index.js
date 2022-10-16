require('dotenv').config({path: `${__dirname}/.env`});

const {isNull} = require("@abhijithvijayan/ts-utils");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const express = require('express');
const cors = require("cors");

const server = express();

// 'a,b,c' => ['a', 'b', 'c']
function extractFromString(str) {
    return str
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
}

const getBrowser = async () => {
    let browser = null;

    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

    } catch (err) {
        console.log({err})
    }

   return browser
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

server.get('/', async (req, res) => {
    const browser = await getBrowser();
    const url = req.query.url;

    if (!isNull(browser) && !isNull(url)) {
        let page = await browser.newPage();
        console.debug({msg: "loading page"});

        // load page
        await page.goto(url, { waitUntil: 'networkidle0' });
        console.debug({msg: "page loaded"});

        let bodyHTML = await page.evaluate(() =>  document.documentElement.outerHTML);
        console.debug({msg: "getting html"})

        // no need to wait for browser to close
        browser.close();

        return res.status(200).json({
            status: "OK",
            data: {
                html: bodyHTML
            }
        })
    }

    res.sendStatus(500);
});

module.exports = server;