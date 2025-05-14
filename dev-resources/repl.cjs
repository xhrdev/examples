/*
 * run this script:

node --watch dev-resources/repl.cjs

*/
const fs = require('node:fs');
const cheerio = require('cheerio');
const amazonjsonui = fs.readFileSync( './test/fixtures/json-amazonui.json', 'utf8');;
const reviewHtml = fs.readFileSync('./test/fixtures/amazon-review.html', 'utf8');
const $ = cheerio.load(reviewHtml);

const totalReviews = $('div[data-hook=cr-filter-info-review-rating-count]').text().trim().match(/(\d+)/)?.[1];

const reviewsFromAjax = JSON.parse(amazonjsonui.split('\n').filter(_ => _ !== '&&&')[6]);
console.log({reviewsFromAjax});

const selector1 = '.reviews-content .a-unordered-list li';
let reviews = $(selector1)
  .toArray()
  .map((li) => {
    const el = $(li);

    let country = '';
    let date = '';
    const match = el.find('span[data-hook="review-date"]').text().match(/^Reviewed in the (.+?) on (.+)$/);
    if (match) {
      country = match[1];
      date = match[2];
    }

    return {
      id: el.attr('id'),
      author: el.find('div.a-profile-content span.a-profile-name').first().text(),
      title: el.find('a[data-hook="review-title"] span:nth-child(3)').text(),
      rating: el.find('i[data-hook="review-star-rating"] span').text().slice(0,3),
      country,
      date,
      text: el.find('span[data-hook="review-body"] span').text().trim(),
    };
  });

const selector2 = '#cm-cr-dp-review-list li';
let productReviews = $(selector2)
  .toArray()
  .map((li) => {
    const el = $(li);

    let country = '';
    let date = '';
    const match = el.find('span[data-hook="review-date"]').text().match(/^Reviewed in the (.+?) on (.+)$/);
    if (match) {
      country = match[1];
      date = match[2];
    }

    return {
      id: el.attr('id'),
      author: el.find('div.a-profile-content span.a-profile-name').first().text(),
      title: el.find('a[data-hook="review-title"] span:nth-child(3)').text(),
      rating: el.find('i[data-hook="review-star-rating"]').text().slice(0, 3),
      country,
      date,
      text: el.find('span[data-hook="review-body"] div[data-hook="review-collapsed"] span').text(),
    };
  });
