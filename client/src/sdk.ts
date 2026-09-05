import axios from "axios";

const getTokenFree = async (baseUrl: string, data: any = {}) => {
  const url = `${baseUrl}/__free__/api/get_token`;
  return axios({
    method: "POST",
    url: url,
    data: {
      ...data,
    },
    headers: {
      "x-access-type": "FREE",
      "Accept-Encoding": "identity",
    },
  });
};

export {
  getTokenFree,
};
