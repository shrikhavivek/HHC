import { test, expect } from "@playwright/test";
import { captureRedditCarousel } from "./scripts/reddit-carousel.mjs";
import { redditSessionState, waitForRedditLogin } from "./scripts/reddit-login.mjs";

async function fixture(page, {repeat=false, controls=true, video=false}={}) {
  await page.route("https://i.redd.it/**", route => route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="red"/></svg>'}));
  await page.route("https://www.reddit.com/**", route => route.fulfill({contentType:"text/html",body:`
    <style>gallery-carousel {display:block;position:relative;width:480px;height:640px;overflow:hidden} img {width:480px;height:640px} button {position:absolute;top:300px} #next {right:0}</style>
    <shreddit-post id="t3_abc" gallery><gallery-carousel>
      ${video ? '<video width="480" height="640"></video>' : '<img id="photo" src="https://i.redd.it/one.jpg">'}
      ${controls ? '<button aria-label="Previous" id="prev" disabled>Previous</button><button aria-label="Next" id="next">Next</button>' : ''}
    </gallery-carousel></shreddit-post>
    <shreddit-post id="t3_unrelated"><img src="https://i.redd.it/recommendation.jpg"></shreddit-post>
    <script>
      let index=0; const names=['one','two','three'];
      document.querySelector('#next')?.addEventListener('click',()=>{
        ${repeat ? '' : "index++; document.querySelector('#photo').src='https://i.redd.it/'+names[index]+'.jpg';"}
        document.querySelector('#prev').disabled=false;
        if(index===2) document.querySelector('#next').disabled=true;
      });
    </script>`}));
  await page.goto("https://www.reddit.com/r/Fashion/comments/abc/title/");
  await page.locator('img').first().evaluate(image => image.decode());
}

test("screenshots every carousel photo in order and excludes recommendations", async ({page}) => {
  await fixture(page);
  const result = await captureRedditCarousel(page);
  expect(result.complete).toBe(true);
  expect(result.photos.map(photo=>photo.url)).toEqual(['one','two','three'].map(name=>`https://i.redd.it/${name}.jpg`));
  expect(result.photos.every(photo=>photo.bytes.length>1000)).toBe(true);
});

test("a gallery without navigation cannot be reported as complete", async ({page}) => {
  await fixture(page, {controls:false});
  await expect(captureRedditCarousel(page)).rejects.toThrow(/controls are missing/);
});

test("a stuck carousel keeps the current draft intact", async ({page}) => {
  await fixture(page, {repeat:true});
  await expect(captureRedditCarousel(page, {pause:async()=>{}})).rejects.toThrow(/repeated a slide/);
});

test("video slides are not captured as photos", async ({page}) => {
  await fixture(page, {video:true});
  await expect(captureRedditCarousel(page)).rejects.toThrow(/video/);
});

test("login waits for the user and continues only on signed-in navigation", async ({page}) => {
  await page.route('https://www.reddit.com/**', route => route.fulfill({contentType:'text/html',body: new URL(route.request().url()).pathname === '/login/' ? '<input type="password"><button>Log in</button>' : '<a href="/settings/">Settings</a>'}));
  await page.goto('https://www.reddit.com/login/');
  expect(await redditSessionState(page)).toBe('waiting');
  await expect(page.locator('input')).toHaveValue('');
  let resumed=false;
  const waiting=waitForRedditLogin(page,{pollMs:10}).then(()=>{resumed=true;});
  expect(resumed).toBe(false);
  await page.goto('https://www.reddit.com/');
  await waiting;
  expect(resumed).toBe(true);
});

test("public pages and blocked pages cannot confirm login", async ({page}) => {
  await page.route('https://www.reddit.com/**', route => route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname === '/blocked/' ? '<p>You have been blocked by network security</p><a href="/settings/">Settings</a>' : '<a href="/settings/" hidden>Settings</a><p>Public post</p>'}));
  await page.goto('https://www.reddit.com/');
  expect(await redditSessionState(page)).toBe('waiting');
  await page.goto('https://www.reddit.com/blocked/');
  expect(await redditSessionState(page)).toBe('blocked');
  let time=0;
  await expect(waitForRedditLogin(page,{timeoutMs:20,now:()=>time,pause:async()=>{time+=20;}})).rejects.toThrow(/sign-in was not confirmed/);
});

test("Reddit shadow controls work and screenshots exclude letterboxing and pagination", async ({page}) => {
  await fixture(page, {controls:false});
  await page.locator('gallery-carousel').evaluate(frame => {
    frame.style.width='640px'; frame.style.height='480px';
    frame.innerHTML=['one','two'].map((name,index)=>`<li slot="page-${index+1}" style="position:absolute;inset:0;list-style:none;visibility:${index===0?'visible':'hidden'}"><img src="https://i.redd.it/${name}.jpg" style="width:640px;height:480px;object-fit:contain"><div hidden><img src="https://i.redd.it/${name}.jpg"></div></li>`).join('');
    const shadow=frame.attachShadow({mode:'open'});
    shadow.innerHTML='<style>.pager{position:absolute;bottom:0;left:280px;width:80px;height:24px;background:black;display:flex}button{width:32px;height:24px}.next{position:absolute;right:0;top:220px}.prev{position:absolute;left:0;top:220px}</style><slot name="page-1"></slot><slot name="page-2"></slot><div class="pager"><button>Page 1</button><button>Page 2</button></div><button class="prev" aria-label="Previous page" disabled>Back</button><button class="next" aria-label="Next page">Next</button>';
    shadow.querySelector('.next').onclick=()=>{
      frame.querySelector('[slot="page-1"]').style.visibility='hidden';
      frame.querySelector('[slot="page-2"]').style.visibility='visible';
      shadow.querySelector('.next').disabled=true;
      shadow.querySelector('.prev').disabled=false;
    };
  });
  await page.locator('gallery-carousel > li > img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
  const result=await captureRedditCarousel(page);
  expect(result.photos).toHaveLength(2);
  const pixels=await page.evaluate(async data=>{
    const image=new Image(); image.src=`data:image/jpeg;base64,${data}`; await image.decode();
    const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
    const context=canvas.getContext('2d'); context.drawImage(image,0,0);
    return {width:image.width,height:image.height,bottom:[...context.getImageData(image.width/2,image.height-8,1,1).data]};
  },result.photos[0].bytes.toString('base64'));
  expect(pixels.width).toBe(360); expect(pixels.height).toBe(480);
  expect(pixels.bottom[0]).toBeGreaterThan(240); expect(pixels.bottom[1]).toBeLessThan(15);
});

test("a signed-in account is detected when Reddit hides its account links", async ({page}) => {
  await page.route('https://www.reddit.com/**', route=>route.fulfill({contentType:'text/html',body:'<nav><button>Menu</button></nav>'}));
  await page.route('https://www.reddit.com/api/me.json', route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:{id:'test-account'}})}));
  await page.goto('https://www.reddit.com/');
  await waitForRedditLogin(page,{pause:async()=>{throw new Error('Should detect the signed-in session');}});
});
