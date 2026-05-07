import { get, post, route } from 'remix/fetch-router/routes'

export const routes = route({
  assets: get('/assets/*path'),
  home: '/',
  auth: route('auth', {
    signIn: get('sign-in'),
    callback: get('callback'),
    signOut: post('sign-out'),
  }),
})
