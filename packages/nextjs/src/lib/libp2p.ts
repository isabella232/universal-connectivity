import { createLibp2p, Libp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webTransport } from '@libp2p/webtransport'
import { bootstrap } from '@libp2p/bootstrap'
import { MemoryDatastore } from 'datastore-core'
import { peerIdFromString } from '@libp2p/peer-id'
import { kadDHT } from '@libp2p/kad-dht'
import type { PeerInfo } from '@libp2p/interface-peer-info'
import type { Multiaddr } from '@multiformats/multiaddr'
import { protocols, Protocol } from '@multiformats/multiaddr'
import { LevelDatastore } from 'datastore-level'
import isIPPrivate from 'private-ip'
import { delegatedPeerRouting } from '@libp2p/delegated-peer-routing'
import { create as KuboClient } from 'kubo-rpc-client'

import { webSockets } from '@libp2p/websockets'

export async function startLibp2p() {
  // localStorage.debug = 'libp2p*,-*:trace'
  // application-specific data lives in the datastore
  // const datastore = new MemoryDatastore()
  const datastore = new LevelDatastore('js-libp2p-nextjs-example')

  // default is to use ipfs.io
  const client = KuboClient({
    // use default api settings
    protocol: 'https',
    port: 443,
    host: 'node0.delegate.ipfs.io',
  })

  // libp2p is the networking layer that underpins Helia
  const libp2p = await createLibp2p({
    connectionManager: { autoDial: true },
    dht: kadDHT(),
    datastore,
    transports: [webTransport(), webSockets()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      bootstrap({
        list: [
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
          '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
          // '/dns4/am6.bootstrap.libp2p.io/tcp/443/wss/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
          // '/dnsaddr/ny5.bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
          // '/dns4/ny5.bootstrap.libp2p.io/tcp/443/wss/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',

          // '/dns4/node0.preload.ipfs.io/tcp/443/wss/p2p/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
          // '/dns4/node1.preload.ipfs.io/tcp/443/wss/p2p/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6',
          // '/dns4/node2.preload.ipfs.io/tcp/443/wss/p2p/QmV7gnbW5VTcJ3oyM2Xk1rdFBJ3kTkvxc87UFGsun29STS',
          // '/dns4/node3.preload.ipfs.io/tcp/443/wss/p2p/QmY7JB6MQXhxHvq7dBDh4HpbH29v4yE9JRadAVpndvzySN',
        ],
      }),
    ],
    // peerRouting: [delegatedPeerRouting(client)],
  })

  console.log(`this nodes peerID: ${libp2p.peerId.toString()}`)
  return libp2p
}

// Curried function to get multiaddresses for a peer by looking up dht
export const getPeerMultiaddrs =
  (libp2p: Libp2p) =>
  async (peerId: string): Promise<Multiaddr[]> => {
    const peer = peerIdFromString(peerId)

    let multiaddrs: Multiaddr[]

    outer: while (true) {
      try {
        // 👇 How does `dht.findPeer` work when in client mode?
        // IIUC, `libp2p.dht.findPeer` sends a DHT client request to one of the bootstrap nodes it manages to connect to
        // Main constraint is that in secure context can only connect to peers with a TLS certificate, WebRTC peers, or WebTransport peers
        for await (const event of libp2p.dht.findPeer(peer)) {
          console.log('findPeer event: ', event)
          if (event.name === 'FINAL_PEER') {
            multiaddrs = event.peer.multiaddrs
            break outer
          }
        }
      } catch (e) {
        console.log(e)
      }
      console.log('wait 10 seconds before next dht lookup')
      await new Promise((resolve, reject) => {
        setTimeout(() => resolve(null), 10 * 1000)
      })
    }

    return multiaddrs
  }

// Attempt to connect to an array of multiaddrs
export const connectToMultiaddrs =
  (libp2p: Libp2p) => async (multiaddrs: Multiaddr[]) => {
    const publicWebTransportMultiaddrs = filterPublicMultiaddrs(multiaddrs)

    if (publicWebTransportMultiaddrs.length === 0) {
      throw new Error('No Public WebTransport multiaddrs found for this peer')
    }

    console.log(publicWebTransportMultiaddrs.map((addr) => addr.toString()))

    const conns = []
    const errs = []
    for (const multiaddr of publicWebTransportMultiaddrs) {
      try {
        conns.push(await libp2p.dial(multiaddr))
      } catch (e) {
        errs.push(e)
        console.error(e)
      }
    }
    if (conns.length === 0) {
      throw new Libp2pDialError('Failed to connect to peer', errs)
    }
    return conns
  }

/**
 * Returns a filtered list of public multiaddrs of a specific protocol
 *
 * @param multiaddrs multiaddrs to filter out
 * @param selectedProtocol protoc
 * @returns
 */
export const filterPublicMultiaddrs = (
  multiaddrs: Multiaddr[],
  selectedProtocol: Protocol = protocols('webtransport'),
): Multiaddr[] => {
  return (
    multiaddrs
      // Filter out private IPs
      .filter((multiaddr) => {
        return !isIPPrivate(multiaddr.toOptions().host)
      })
      .filter((addr) => {
        const res = addr
          .protoCodes()
          .filter((pt) => protocols(pt)?.name === selectedProtocol.name)

        return res.length > 0
      })
  )
}

/**
 * Custom Libp2p Dial Error that can hold an array of dial error objects
 */
export class Libp2pDialError extends Error {
  // error can be an array of dial errors
  error: object
  constructor(message: string, error: object) {
    super(message)
    Object.setPrototypeOf(this, Libp2pDialError.prototype)
    this.error = error
  }
}
