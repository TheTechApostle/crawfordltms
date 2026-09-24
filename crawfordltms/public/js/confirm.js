// Event-delegated confirm() for any submit control carrying
// data-confirm="..." — used instead of inline onclick="return confirm(...)"
// because some browsers handle the combination of an inline onclick return
// value and an external form="" association (a button submitting a <form>
// it isn't nested inside) inconsistently. Listening at the document level
// and calling preventDefault() is the standards-compliant way to get the
// same "are you sure?" behavior without relying on that combination.
document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-confirm]');
  if (!el) return;
  if (!window.confirm(el.getAttribute('data-confirm'))) {
    e.preventDefault();
  }
});
