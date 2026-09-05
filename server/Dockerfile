FROM node:lts-alpine
LABEL maintainer="sombochea@cubis.tech"

ARG JSON_FLAGS

WORKDIR /usr/src/app

# Write the JSON_FLAGS to the file `build.json`
RUN echo $JSON_FLAGS > ./build.json

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
