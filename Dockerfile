FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY server.js .

EXPOSE 8006

CMD [ "npm", "start" ]
