/*
 * run this script:

node --watch dev-resources/repl.cjs

*/
const fs = require('node:fs');
const cheerio = require('cheerio');
const productHtml = fs.readFileSync('./test/fixtures/amazon-product.html', 'utf8');
const reviewHtml = fs.readFileSync('./test/fixtures/amazon-review.html', 'utf8');
const amazonjsonui = fs.readFileSync( './test/fixtures/json-amazonui.json', 'utf8');;
const reviewsHtmlFromAjax = JSON.parse(amazonjsonui.split('\n').filter(_ => _ !== '&&&')[6])[2];

const totalReviews = cheerio.load(reviewHtml)('div[data-hook=cr-filter-info-review-rating-count]').text().trim().match(/(\d+)/)?.[1];

const selector1 = '#cm-cr-dp-review-list li';
let productReviews = (html) => cheerio.load(html)(selector1)
  .toArray()
  .map((li) => {
    const el = cheerio.load(html)(li);

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

const selector2 = '.reviews-content .a-unordered-list li';
let reviews = (html) => cheerio.load(html)(selector2)
  .toArray()
  .map((li) => {
    const el = cheerio.load(html)(li);

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

const selector3 = 'ul.a-unordered-list li';
let ajaxReviews = (html) => cheerio.load(html)(selector3)
  .toArray()
  .map((li) => {
    const el = cheerio.load(html)(li);

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
      text: el.find('span[data-hook="review-body"] span').text().trim() || null,
    };
  });

console.log(totalReviews)
// console.log(reviews(reviewHtml))
// console.log(productReviews(productHtml))
// console.log(reviewsHtmlFromAjax);
// fs.writeFileSync('./ajax-reviews.html', reviewsHtmlFromAjax);
// console.log(ajaxReviews(reviewsHtmlFromAjax));

console.log(JSON.parse(cheerio.load(productHtml)('span#nav-global-location-data-modal-action').attr('data-a-modal')).ajaxHeaders)
