export function postId(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["reddit.com", "www.reddit.com"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("Expected a Reddit post URL");
  const id = url.pathname.match(/^\/r\/[^/]+\/comments\/([a-z0-9]+)(?:\/|$)/)?.[1];
  if (!id) throw new Error("Expected an individual Reddit post");
  return id;
}

function original(value) {
  const url = new URL(String(value).replaceAll("&amp;", "&"));
  if (url.protocol !== "https:" || !["i.redd.it", "preview.redd.it"].includes(url.hostname) || url.username || url.password || url.port || !/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(url.pathname)) throw new Error("Reddit did not expose an original photo");
  return `https://i.redd.it${url.pathname}`;
}

export function galleryFromListing(listing, expectedId) {
  const post = listing?.[0]?.data?.children?.find(item => item.kind === "t3" && item.data?.id === expectedId)?.data;
  if (!post) throw new Error("The response did not contain the requested post");
  let images;
  if (post.is_gallery || post.gallery_data) {
    const items = post.gallery_data?.items;
    if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error("The complete gallery is unavailable or exceeds the supported limit");
    images = [];
    for (const item of items) {
      const media = post.media_metadata?.[item.media_id];
      if (!media || media.status !== "valid") throw new Error("A gallery slide is unavailable");
      if (media.e !== "Image") continue;
      images.push(original(media.s?.u));
    }
  } else {
    if (post.is_video) throw new Error("This post is a video");
    images = [original(post.url_overridden_by_dest || post.url)];
  }
  if (!images.length || new Set(images).size !== images.length) throw new Error("The photo gallery is empty or contains duplicate slides");
  return images;
}
