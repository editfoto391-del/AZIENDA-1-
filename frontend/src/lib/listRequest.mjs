export function listViewState({ loading, error, items }) {
  if (loading) return "loading";
  if (error) return "error";
  return items.length === 0 ? "empty" : "items";
}

export async function loadListRequest({ request, setState, errorMessage, showLoading = true }) {
  if (showLoading) {
    setState((current) => ({ ...current, loading: true, error: "" }));
  } else {
    setState((current) => ({ ...current, error: "" }));
  }

  try {
    const items = await request();
    if (!Array.isArray(items)) {
      throw new TypeError("The server returned an invalid list response");
    }
    setState({ items, loading: false, error: "" });
    return true;
  } catch (error) {
    setState((current) => ({
      ...current,
      loading: false,
      error: errorMessage(error),
    }));
    return false;
  }
}
