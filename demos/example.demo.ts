import { test } from '@argo-video/cli';
import { showCaption, withCaption } from '@argo-video/cli';

test('example', async ({ page, narration }) => {
  await page.goto('/');
  await page.locator('.titleline a').first().waitFor();
  await page.waitForTimeout(1000);

  const firstStory = page.locator('.titleline a').first();
  const firstStoryMeta = page.locator('.subline').first();
  const firstStoryComments = firstStoryMeta.locator('a').last();
  const commentsHref = await firstStoryComments.getAttribute('href');
  if (!commentsHref) {
    throw new Error('Could not find the comments link for the top Hacker News story.');
  }
  const commentsUrl = new URL(commentsHref, page.url()).toString();

  narration.mark('intro');
  await showCaption(page, 'intro', 'Hacker News — the front page of the internet', 3000);

  narration.mark('browse');
  await showCaption(page, 'browse', 'Let\'s check out the top story', 2000);

  await firstStory.hover();
  await page.waitForTimeout(500);
  await firstStory.click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  narration.mark('back');
  await page.goto('/');
  await page.locator('.titleline a').first().waitFor();
  await page.waitForTimeout(1000);

  narration.mark('comments');
  await withCaption(page, 'comments', 'Now let\'s see what people are saying', async () => {
    await page.goto(commentsUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.comment-tree').waitFor({ timeout: 15000 });
    await page.waitForTimeout(8000);
  });

  narration.mark('done');
  await showCaption(page, 'done', 'That\'s Hacker News!', 2000);
});
