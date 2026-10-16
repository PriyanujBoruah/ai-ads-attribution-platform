export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  const SHOPIFY_CLIENT_ID = env.SHOPIFY_CLIENT_ID || '';
  const SHOPIFY_CLIENT_SECRET = env.SHOPIFY_CLIENT_SECRET || '';
  const SHOPIFY_SCOPES = 'read_orders,read_products,read_returns,read_discounts,read_customers,read_fulfillments,read_shipping,read_marketing_events,read_analytics';

  if (pathname === '/api/auth/shopify/authorize') {
    const rawShop = url.searchParams.get('shop');
    if (!rawShop) {
      return new Response(JSON.stringify({ error: true, message: 'Missing shop domain in query parameter ?shop=' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let sanitizedShop = rawShop.replace(/^(https?:\/\/)?/, '').replace(/\/$/, '').trim();
    if (!sanitizedShop.includes('.')) {
      sanitizedShop += '.myshopify.com';
    }

    const redirectUri = `${url.origin}/api/auth/shopify/callback`;
    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const authorizeUrl = `https://${sanitizedShop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${SHOPIFY_SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    return Response.redirect(authorizeUrl, 302);
  }

  if (pathname === '/api/auth/shopify/callback') {
    const shop = url.searchParams.get('shop');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(errorDescription || error)}`, 302);
    }

    if (!shop || !code) {
      return new Response('Missing required shop or code query parameters.', { status: 400 });
    }

    let sanitizedShop = shop.replace(/^(https?:\/\/)?/, '').replace(/\/$/, '').trim();
    const tokenEndpoint = `https://${sanitizedShop}/admin/oauth/access_token`;

    try {
      const tokenResp = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: SHOPIFY_CLIENT_ID,
          client_secret: SHOPIFY_CLIENT_SECRET,
          code: code
        })
      });

      const tokenData = await tokenResp.json();

      if (tokenData.access_token) {
        const redirectBack = `${url.origin}/?connected=shopify&shop=${encodeURIComponent(sanitizedShop)}&token=${encodeURIComponent(tokenData.access_token)}&scope=${encodeURIComponent(tokenData.scope || '')}`;
        return Response.redirect(redirectBack, 302);
      } else {
        return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(tokenData.error_description || tokenData.error || 'Token exchange failed')}`, 302);
      }
    } catch (e) {
      return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(e.message)}`, 302);
    }
  }

  return new Response('Not Found', { status: 404 });
}
