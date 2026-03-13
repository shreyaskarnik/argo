import { test, demoType } from 'argo';

test('example', async ({ page, narration }) => {
  await page.goto('/');
  await narration.showCaption(page, 'welcome', 'Welcome to our app', 3000);
  await narration.withCaption(page, 'action', 'Watch how easy it is', async () => {
    await page.click('button');
  });
  narration.mark('done');
});
