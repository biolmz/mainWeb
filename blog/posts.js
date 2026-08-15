// ============================================================
//  posts.json 加载器
//  添加新博客只需编辑 posts.json，此处无需改动
//  格式：{ title, url, date, desc?, tag? }
//  date 格式：YYYY-MM-DD
// ============================================================

const postList = document.getElementById("postList");

fetch("posts.json")
  .then(res => {
    if (!res.ok) throw new Error("无法加载 posts.json");
    return res.json();
  })
  .then(posts => renderPosts(posts))
  .catch(() => {
    postList.innerHTML = '<li class="empty">加载失败，请确保 posts.json 与 index.html 在同一目录。</li>';
  });

function renderPosts(posts) {
  if (!posts || posts.length === 0) {
    postList.innerHTML = '<li class="empty">暂无文章，敬请期待。</li>';
    return;
  }
  postList.innerHTML = "";
  posts.forEach(post => {
    const li = document.createElement("li");
    li.className = "post-item";
    const dateStr = post.date || "";
    const descHtml = post.desc
      ? '<div class="post-desc">' + escapeHtml(post.desc) + '</div>'
      : "";
    const tagHtml = post.tag
      ? '<span class="tag">' + escapeHtml(post.tag) + '</span>'
      : "";
    li.innerHTML =
      '<a href="' + escapeHtml(post.url) + '" target="_blank" rel="noopener noreferrer" class="post-link">' +
        '<div class="post-title">' + escapeHtml(post.title) + '</div>' +
        '<div class="post-meta">' +
          tagHtml +
          (dateStr ? '<span>' + dateStr + '</span><span class="dot"></span>' : "") +
          '<span>外部链接 &nearr;</span>' +
        '</div>' +
        descHtml +
      '</a>';
    postList.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
