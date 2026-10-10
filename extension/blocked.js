// Offer "Go back" only when there is somewhere to go back to.
const back = document.getElementById('back');
if (history.length > 1) {
  back.hidden = false;
  back.addEventListener('click', () => history.back());
}
