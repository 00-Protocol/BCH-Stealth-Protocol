import { sdk } from '../sdk'

export const seedFiles = sdk.setupOnInit(async () => {
  // Cache dirs are created in the Docker image (Dockerfile: mkdir -p /data/pubkeys/json /data/pubkeys/bin)
})
