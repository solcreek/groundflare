using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "bench", worker = .benchWorker) ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "bench") ],
);

const benchWorker :Workerd.Worker = (
  compatibilityDate = "2026-04-01",
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
);
