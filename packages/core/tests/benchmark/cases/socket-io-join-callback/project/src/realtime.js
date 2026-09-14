const http = require("http")
const socketIo = require("socket.io")

const server = http.createServer()
const io = socketIo(server)

io.on("connection", (socket) => {
  socket.on("join", (room) => {
    socket.join(room, () => {
      io.to(room).emit("joined", { id: socket.id, room })
    })
  })
})

server.listen(process.env.PORT || 3000)
